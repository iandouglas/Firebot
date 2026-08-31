import { shell } from "electron";
import { EventEmitter } from "events";

import type { AuthDetails } from "../../../../types";
import type ClientOAuth2 from "client-oauth2";

import authManager from "../../../auth/auth-manager";
import frontendCommunicator from "../../../common/frontend-communicator";
import { SettingsManager } from "../../../common/settings-manager";
import { LoggerCache } from "../../../logger-cache";

import { youtubeAccountStore } from "./account-store";
import { youTubeApiClient as apiClient } from "./youtube-api-client";
import { youtubeChatEvents, type YouTubeAccountType, type YouTubeChannelInfo } from "./contracts";
import { youtubeLiveMonitor } from "./live-monitor";
import "./chat-ingest";
import { startMembersRoster, stopMembersRoster } from "./members-roster";
// WS-6: cross-platform relay — side-effect import so its settings poller runs
// for the app's lifetime (self-manages subscribe/unsubscribe).
import "./chat-relay";
// WS-7: registers the "youtube" event source (Events UI), the ingest → event
// mapping and the YouTube replace variables. Idempotent; see events/index.ts.
import { registerYouTubeEvents } from "./events";
import {
    BOT_ACCOUNT_PROVIDER_ID,
    STREAMER_ACCOUNT_PROVIDER_ID,
    botAccountProvider,
    hasGoogleCredentials,
    streamerAccountProvider
} from "./youtube-auth";

const logger = LoggerCache.getLogger("YouTube");

/**
 * Settings persisted under /integrations/youtube/settings via the integration
 * "settings-update" event (integration-manager persists them and mirrors them
 * onto definition.settings). `botAuth` holds the bot token blob (the streamer
 * token is persisted by integration-manager itself at /integrations/youtube/auth).
 *
 * relayEnabled/relayMaxPerMinute are pre-registered for WS-6 (cross-platform relay).
 */
interface YouTubeIntegrationSettings {
    linked?: boolean;
    botAuth?: AuthDetails | null;
    botChannel?: YouTubeChannelInfo | null;
    streamerChannel?: YouTubeChannelInfo | null;
    relayEnabled?: boolean;
    relayMaxPerMinute?: number;
}

interface IntegrationInitData {
    oauth?: AuthDetails;
    accountId?: string;
    settings?: YouTubeIntegrationSettings;
    userSettings?: unknown;
}

interface IntegrationConnectData {
    auth?: AuthDetails;
    oauth?: AuthDetails;
    accountId?: string;
    settings?: YouTubeIntegrationSettings;
    userSettings?: unknown;
}

const INTEGRATION_ID = "youtube";

const integrationDefinition = {
    id: INTEGRATION_ID,
    name: "YouTube",
    description: "Native YouTube support: chat, moderation, monetization events and stream control.",
    linkType: "auth",
    connectionToggle: true,
    configurable: true,
    // Streamer provider ONLY — the bot provider is registered inside init().
    authProviderDetails: streamerAccountProvider,
    settingCategories: {
        botAccount: {
            title: "Bot Account",
            sortRank: 1,
            settings: {
                botAuth: {
                    title: "Bot Account",
                    description: "Links a second Google/YouTube account as a chat bot. It should be a moderator on your channel.",
                    type: "youtube-bot-auth",
                    sortRank: 1
                }
            }
        },
        relaySettings: {
            title: "Cross-Platform Relay",
            description: "Settings for relaying chat between Twitch and YouTube while both platforms are live (built by WS-6).",
            sortRank: 2,
            settings: {
                relayEnabled: {
                    title: "Enable Chat Relay",
                    description: "While you are live on both platforms, relay messages from each chat into the other. Format: [Twitch] Name: message and [YT] Name: message.",
                    type: "boolean",
                    default: false,
                    sortRank: 1
                },
                relayMaxPerMinute: {
                    title: "Relay Max Per Minute",
                    description: "Maximum number of relayed messages sent to each platform per minute.",
                    type: "number",
                    default: 12,
                    sortRank: 2
                }
            }
        }
    }
};

class YouTubeIntegration extends EventEmitter {
    connected = false;

    private _settings: YouTubeIntegrationSettings = {};
    private _authListenersWired = false;
    private _accountStoreHookWired = false;
    private _frontendRoutesWired = false;
    private _botProviderRegistered = false;

    init(_linked: boolean, integrationData: IntegrationInitData): void {
        this._settings = this._cloneSettings(integrationData?.settings);

        if (!hasGoogleCredentials()) {
            logger.warn(
                "secrets.json is missing googleClientId/googleClientSecret. The YouTube integration stays disabled until Google OAuth client credentials are added (see SETUP.md)."
            );
        } else if (!this._botProviderRegistered) {
            // The bot provider is registered here and ONLY here — never on the
            // definition, so integration-manager's generic auth-success linker
            // (which matches definition.authProviderDetails.id) can not link the
            // integration with a bot token.
            authManager.registerAuthProvider(botAccountProvider);
            this._botProviderRegistered = true;
        }

        // Restore persisted account state (streamer token comes from definition.auth).
        if (integrationData?.oauth?.access_token != null) {
            youtubeAccountStore.setAuth("streamer", integrationData.oauth, { emitUpdate: false });
        }
        if (this._settings.streamerChannel != null) {
            youtubeAccountStore.setChannel("streamer", this._settings.streamerChannel, { emitUpdate: false });
        }
        if (this._settings.botAuth?.access_token != null) {
            youtubeAccountStore.setAuth("bot", this._settings.botAuth, { emitUpdate: false });
        }
        if (this._settings.botChannel != null) {
            youtubeAccountStore.setChannel("bot", this._settings.botChannel, { emitUpdate: false });
        }

        this._wireAccountStorePersistence();
        this._wireAuthSuccessListener();
        this._wireFrontendRoutes();

        // WS-7: event source + variables registration (see events/index.ts).
        registerYouTubeEvents();

        // WS-2: the live monitor is lifecycle-driven from connect()/disconnect();
        // the chat reader (stub in chat-ingest.ts) is driven by the monitor's
        // transitions — WS-4 owns the implementation.
    }

    /**
     * Called by integration-manager after it accepted a streamer auth-success
     * (it saved definition.auth and marked the integration linked). We fetch
     * + cache channel info and persist it through the settings-update mechanism.
     */
    async link(linkData: { auth?: AuthDetails }): Promise<void> {
        const auth = linkData?.auth;
        if (auth?.access_token == null) {
            logger.error("YouTube link called without a streamer auth token.");
            return;
        }

        youtubeAccountStore.setAuth("streamer", auth, { emitUpdate: false });

        try {
            const channel = await apiClient.getMyChannel("streamer");
            youtubeAccountStore.setChannel("streamer", channel);
            this._persistSettings({ streamerChannel: channel, linked: true });

            const account = youtubeAccountStore.getStreamerAccount();
            if (account != null) {
                youtubeChatEvents.emit("account-linked", account);
            }

            logger.info(`YouTube streamer account linked: ${channel.channelTitle} (${channel.channelId})`);
        } catch (error) {
            // The streamer auth is already persisted by integration-manager; the
            // channel can be lazily re-fetched during the next connect.
            logger.error("Failed to fetch YouTube channel info after streamer link:", error instanceof Error ? error.message : error);
        }
    }

    unlink(): void {
        // WS-2: stop the live monitor (which also stops the chat reader hook).
        youtubeLiveMonitor.stop();
        stopMembersRoster();
        youtubeAccountStore.clearAll();
        this._settings = {};
        logger.info("YouTube integration unlinked; cached accounts cleared.");
    }

    async connect(integrationData: IntegrationConnectData): Promise<void> {
        if (integrationData?.settings != null) {
            this._settings = { ...this._settings, ...integrationData.settings };
        }

        const streamerAuth = integrationData?.auth ?? integrationData?.oauth;
        if (streamerAuth?.access_token == null) {
            logger.warn("Cannot connect YouTube: no streamer token available (integration not linked?).");
            this.emit("disconnected", INTEGRATION_ID);
            return;
        }

        // Core invariant #5: refresh both tokens on every connect. The streamer
        // refresh is belt-and-braces (integration-manager already refreshed the
        // primary auth blob); the bot token is ONLY refreshed here.
        const refreshedStreamerAuth = await authManager.refreshTokenIfExpired(
            STREAMER_ACCOUNT_PROVIDER_ID,
            streamerAuth as unknown as ClientOAuth2.Data
        ) as AuthDetails | null;

        if (refreshedStreamerAuth?.access_token == null) {
            logger.warn("Could not refresh the YouTube streamer access token. YouTube stays disconnected.");
            this.connected = false;
            this.emit("disconnected", INTEGRATION_ID);
            return;
        }

        youtubeAccountStore.setAuth("streamer", refreshedStreamerAuth, { emitUpdate: false });
        if (this._settings.streamerChannel != null) {
            youtubeAccountStore.setChannel("streamer", this._settings.streamerChannel, { emitUpdate: false });
        } else {
            // channel info was never persisted (e.g. link()-time fetch failed) —
            // fetch it once now so the account context is complete.
            await this.link({ auth: refreshedStreamerAuth });
        }

        const botAuth = this._settings.botAuth;
        if (botAuth?.access_token != null) {
            if (this._settings.botChannel != null) {
                youtubeAccountStore.setChannel("bot", this._settings.botChannel, { emitUpdate: false });
            }
            const refreshedBotAuth = await authManager.refreshTokenIfExpired(
                BOT_ACCOUNT_PROVIDER_ID,
                botAuth as unknown as ClientOAuth2.Data
            ) as AuthDetails | null;

            if (refreshedBotAuth?.access_token != null) {
                youtubeAccountStore.setAuth("bot", refreshedBotAuth, { emitUpdate: false });
                // Persist the refreshed bot token so weekly expiries inside a
                // session don't silently break bot features.
                this._persistSettings({ botAuth: refreshedBotAuth });
            } else {
                logger.warn("Could not refresh the YouTube bot token. Bot features will be degraded until relink.");
            }
        } else {
            logger.info("No YouTube bot account linked; bot-only features disabled.");
        }

        this.connected = true;

        // WS-2: kick the live monitor (60s live-check poll) before the connected emit.
        youtubeLiveMonitor.start();
        // WS-9: start the members roster refresh (best-effort; no-ops pre-enrollment).
        startMembersRoster();

        this.emit("connected", INTEGRATION_ID);
        logger.info("YouTube integration connected.");
    }

    disconnect(): void {
        // WS-2: stop the live monitor + clear its cached stream state. Note
        // that the integration disconnecting is intentionally NOT treated as a
        // stream offline transition (the broadcast itself may still be live).
        youtubeLiveMonitor.stop();
        stopMembersRoster();
        this.connected = false;
        this.emit("disconnected", INTEGRATION_ID);
        logger.info("YouTube integration disconnected.");
    }

    private _cloneSettings(settings?: YouTubeIntegrationSettings): YouTubeIntegrationSettings {
        return settings != null ? JSON.parse(JSON.stringify(settings)) as YouTubeIntegrationSettings : {};
    }

    private _persistSettings(patch: Partial<YouTubeIntegrationSettings>): void {
        this._settings = {
            ...this._settings,
            ...patch
        };
        this.emit("settings-update", INTEGRATION_ID, { ...this._settings });
    }

    private _wireAccountStorePersistence(): void {
        if (this._accountStoreHookWired) {
            return;
        }

        // Bot tokens are fully owned by this module: whenever the store refreshes
        // or sets them, mirror them into the integration settings blob.
        youtubeAccountStore.on(
            "account-updated",
            (accountType: YouTubeAccountType, context: { auth: AuthDetails | null; channel: YouTubeChannelInfo | null }) => {
                if (accountType !== "bot") {
                    return;
                }

                const patch: Partial<YouTubeIntegrationSettings> = {};
                if (context.auth != null) {
                    patch.botAuth = context.auth;
                }
                if (context.channel != null) {
                    patch.botChannel = context.channel;
                }
                if (Object.keys(patch).length > 0) {
                    this._persistSettings(patch);
                }
            }
        );

        this._accountStoreHookWired = true;
    }

    private _wireAuthSuccessListener(): void {
        if (this._authListenersWired) {
            return;
        }

        authManager.on("auth-success", async (authData: { providerId: string; tokenData: AuthDetails }) => {
            const { providerId, tokenData } = authData;
            if (providerId !== BOT_ACCOUNT_PROVIDER_ID) {
                // The streamer provider is handled by integration-manager
                // (saveIntegrationAuth + linkIntegration -> this.link()).
                return;
            }
            await this._handleBotAuthSuccess(tokenData);
        });

        this._authListenersWired = true;
    }

    private _wireFrontendRoutes(): void {
        if (this._frontendRoutesWired) {
            return;
        }

        frontendCommunicator.on("youtube:link-bot-account", () => this._openBotAccountAuthPage());
        frontendCommunicator.on("youtube:unlink-bot-account", () => this._unlinkBotAccount());

        this._frontendRoutesWired = true;
    }

    private async _handleBotAuthSuccess(tokenData: AuthDetails): Promise<void> {
        if (tokenData?.access_token == null) {
            logger.error("YouTube bot auth-success arrived without a usable token.");
            return;
        }

        youtubeAccountStore.setAuth("bot", tokenData);

        try {
            const channel = await apiClient.getMyChannel("bot");
            youtubeAccountStore.setChannel("bot", channel);

            const account = youtubeAccountStore.getBotAccount();
            if (account != null) {
                youtubeChatEvents.emit("account-linked", account);
            }

            frontendCommunicator.send("youtube:bot-auth-update", {
                linked: true,
                channel: {
                    channelId: channel.channelId,
                    channelTitle: channel.channelTitle,
                    avatarUrl: channel.avatarUrl
                }
            });

            logger.info(`YouTube bot account linked: ${channel.channelTitle} (${channel.channelId})`);
        } catch (error) {
            logger.error("Failed to finish YouTube bot account linking:", error instanceof Error ? error.message : error);
        }
    }

    private _openBotAccountAuthPage(): void {
        if (!hasGoogleCredentials()) {
            logger.error("Cannot link a YouTube bot account: googleClientId/googleClientSecret missing from secrets.json.");
            return;
        }

        const webServerPort = SettingsManager.getSetting("WebServerPort");
        void shell.openExternal(`http://localhost:${webServerPort}/api/v1/auth?providerId=${encodeURIComponent(BOT_ACCOUNT_PROVIDER_ID)}`);
    }

    private _unlinkBotAccount(): void {
        youtubeAccountStore.clear("bot");
        this._persistSettings({
            botAuth: null,
            botChannel: null
        });
        frontendCommunicator.send("youtube:bot-auth-update", { linked: false });
        logger.info("YouTube bot account unlinked.");
    }
}

const youtubeIntegration = new YouTubeIntegration();

export {
    integrationDefinition as definition,
    youtubeIntegration as integration
};

export type { YouTubeIntegrationSettings };
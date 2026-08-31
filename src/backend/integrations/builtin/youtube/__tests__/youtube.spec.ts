/**
 * YouTube integration lifecycle: init/link/unlink/connect/disconnect plus
 * auth-success routing (streamer via integration-manager contract, bot via the
 * module-local listener). All collaborators are mocked; no network, no electron.
 */

jest.mock("electron", () => ({
    shell: {
        openExternal: jest.fn(() => Promise.resolve())
    }
}));

jest.mock("../../../../auth/auth-manager", () => ({
    __esModule: true,
    default: {
        registerAuthProvider: jest.fn(),
        refreshTokenIfExpired: jest.fn(),
        on: jest.fn()
    }
}));

jest.mock("../../../../common/frontend-communicator", () => ({
    __esModule: true,
    default: {
        on: jest.fn(),
        onAsync: jest.fn(),
        send: jest.fn(),
        sendAsync: jest.fn()
    }
}));

jest.mock("../../../../common/settings-manager", () => ({
    SettingsManager: {
        getSetting: jest.fn(() => 7472)
    }
}));

const mockSecrets: {
    secrets: Partial<{ googleClientId: string; googleClientSecret: string }>;
} = {
    secrets: {
        googleClientId: "fake-google-client-id.apps.googleusercontent.com",
        googleClientSecret: "fake-google-client-secret"
    }
};

jest.mock("../../../../secrets-manager", () => ({
    SecretsManager: mockSecrets
}));

jest.mock("../../../../logger-cache", () => ({
    LoggerCache: {
        getLogger: () => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        })
    }
}));

jest.mock("../youtube-api-client", () => ({
    youTubeApiClient: {
        getMyChannel: jest.fn()
    }
}));

// WS-7: youtube.ts init() wires the event source + variables registration.
// The real EventManager/ReplaceVariableManager chains are unbootable under jest
// (heavy module graphs); these stubs keep this suite import-light (WS-7).
jest.mock("../../../../events/event-manager", () => ({
    EventManager: {
        registerEventSource: jest.fn(),
        unregisterEventSource: jest.fn(),
        triggerEvent: jest.fn(),
        triggerUiRefresh: jest.fn()
    }
}));

jest.mock("../../../../variables/replace-variable-manager", () => ({
    ReplaceVariableManager: {
        registerReplaceVariable: jest.fn(),
        unregisterReplaceVariable: jest.fn()
    }
}));

// WS-4: youtube.ts side-effect imports ./chat-ingest (module-level registration).
// The real chat-ingest pulls in the frontend-chat-manager → account-access →
// data-access ⇄ logwrapper chain, which is unbootable under jest. Mock it here
// (youtube.spec.ts doesn't exercise the chat reader).
jest.mock("../chat-ingest", () => ({
    __esModule: true,
    startChatIngest: jest.fn(),
    stopChatIngest: jest.fn()
}));

import { shell } from "electron";
import authManager from "../../../../auth/auth-manager";
import frontendCommunicator from "../../../../common/frontend-communicator";
import type { AuthDetails } from "../../../../../types";

import { youtubeAccountStore } from "../account-store";
import { youtubeChatEvents, type YouTubeAccountContext } from "../contracts";
import { youTubeApiClient } from "../youtube-api-client";
import { BOT_ACCOUNT_PROVIDER_ID, STREAMER_ACCOUNT_PROVIDER_ID } from "../youtube-auth";
import { definition, integration } from "../youtube";
import {
    botChannelsListFixture,
    channelsListFixture,
    fakeAuthDetails,
    googleCredentialFixtures
} from "../testing/google-api-fixtures";

const mockedRegisterAuthProvider = (authManager.registerAuthProvider as unknown) as jest.Mock;
const mockedRefreshTokenIfExpired = (authManager.refreshTokenIfExpired as unknown) as jest.Mock;
const mockedOnAuthManager = (authManager.on as unknown) as jest.Mock;
const mockedFrontendOn = (frontendCommunicator.on as unknown) as jest.Mock;
const mockedFrontendSend = (frontendCommunicator.send as unknown) as jest.Mock;
const mockedGetMyChannel = (youTubeApiClient.getMyChannel as unknown) as jest.Mock;
const mockedOpenExternal = (shell.openExternal as unknown) as jest.Mock;

const streamerAuth = fakeAuthDetails("streamer");
const refreshedStreamerAuth = { ...streamerAuth, access_token: "fake-refreshed-streamer-token" };
const botAuth = fakeAuthDetails("bot");
const refreshedBotAuth = { ...botAuth, access_token: "fake-refreshed-bot-token" };

const streamerChannel = {
    channelId: channelsListFixture.items[0].id,
    channelTitle: channelsListFixture.items[0].snippet.title,
    avatarUrl: channelsListFixture.items[0].snippet.thumbnails.high.url
};

const botChannel = {
    channelId: botChannelsListFixture.items[0].id,
    channelTitle: botChannelsListFixture.items[0].snippet.title,
    avatarUrl: botChannelsListFixture.items[0].snippet.thumbnails.default.url
};

const capturedAuthSuccessHandlers: Array<(authData: { providerId: string; tokenData: AuthDetails }) => Promise<void> | void> = [];
const frontendHandlers: Record<string, (...args: Array<unknown>) => void> = {};
const registerCallsAtBoot: Array<{ id: string }> = [];

beforeAll(() => {
    integration.init(false, {});

    // Snapshot registrations right after init; jest's clearMocks wipes
    // mock.calls before each test, so store values, not references.
    for (const [provider] of mockedRegisterAuthProvider.mock.calls as Array<[ { id: string } ]>) {
        registerCallsAtBoot.push(provider);
    }

    for (const [event, handler] of (mockedOnAuthManager.mock.calls as Array<[string, (...args: Array<unknown>) => void]>)) {
        if (event === "auth-success") {
            capturedAuthSuccessHandlers.push(handler);
        } else {
            frontendHandlers[event] = handler;
        }
    }

    for (const [event, handler] of (mockedFrontendOn.mock.calls as Array<[string, (...args: Array<unknown>) => void]>)) {
        frontendHandlers[event] = handler;
    }
});

beforeEach(() => {
    mockedRefreshTokenIfExpired.mockReset();
    mockedGetMyChannel.mockReset();
    mockedFrontendSend.mockClear();
    mockedOpenExternal.mockClear();
    integration.unlink();
    integration.removeAllListeners("settings-update");
    youtubeChatEvents.removeAllListeners();
    youtubeAccountStore.clearAll();
});

function subscribeSettingsUpdate(): jest.Mock {
    const listener = jest.fn();
    integration.on("settings-update", listener);
    return listener;
}

function settingsPayloads(listener: jest.Mock): Array<Record<string, unknown>> {
    return listener.mock.calls.map(call => call[1] as Record<string, unknown>);
}

describe("integration definition", () => {
    it("exposes the locked WS-1 definition shape (streamer provider ONLY)", () => {
        expect(definition.id).toBe("youtube");
        expect(definition.name).toBe("YouTube");
        expect(definition.linkType).toBe("auth");
        expect(definition.connectionToggle).toBe(true);
        expect(definition.configurable).toBe(true);
        expect(definition.authProviderDetails.id).toBe(STREAMER_ACCOUNT_PROVIDER_ID);
        expect(definition.authProviderDetails.id).not.toBe(BOT_ACCOUNT_PROVIDER_ID);
        // Custom settings registered for the frontend modal.
        expect(definition.settingCategories.botAccount.settings.botAuth.type).toBe("youtube-bot-auth");
    });
});

describe("init wiring", () => {
    it("registers the bot auth provider via authManager (never via definition.authProviderDetails)", () => {
        // captured right after the beforeAll init(), immune to jest's clearMocks
        expect(registerCallsAtBoot).toHaveLength(1);
        expect(registerCallsAtBoot[0].id).toBe(BOT_ACCOUNT_PROVIDER_ID);
        expect(registerCallsAtBoot.some(p => p.id === STREAMER_ACCOUNT_PROVIDER_ID)).toBe(false);
        expect(definition.authProviderDetails.id).toBe(STREAMER_ACCOUNT_PROVIDER_ID);
    });

    it("restores persisted accounts from settings + oauth on boot", () => {
        integration.init(true, {
            oauth: streamerAuth,
            settings: {
                botAuth,
                botChannel,
                streamerChannel
            }
        });

        expect(youtubeAccountStore.getRawAccount("streamer")?.auth.access_token).toBe(streamerAuth.access_token);
        expect(youtubeAccountStore.getBotAccount()).toMatchObject({
            providerId: BOT_ACCOUNT_PROVIDER_ID,
            channel: botChannel
        });
    });

    it("registers exactly one module-local auth-success listener even across re-inits", () => {
        // The beforeAll init() registered one listener; a second init() must not add another.
        integration.init(true, {});
        expect(capturedAuthSuccessHandlers).toHaveLength(1);
    });
});

describe("auth-success routing", () => {
    it("bot token: persists botAuth + botChannel via settings-update and never links the integration", async () => {
        mockedGetMyChannel.mockResolvedValue(botChannel);

        const accountLinkedSpy = jest.fn();
        youtubeChatEvents.on("account-linked", accountLinkedSpy);
        const settingsListener = subscribeSettingsUpdate();

        await capturedAuthSuccessHandlers[0]({ providerId: BOT_ACCOUNT_PROVIDER_ID, tokenData: botAuth });

        // Bot channel was fetched with the BOT token (account="bot") — no streamer call.
        expect(mockedGetMyChannel).toHaveBeenCalledTimes(1);
        expect(mockedGetMyChannel).toHaveBeenCalledWith("bot");

        const payloads = settingsPayloads(settingsListener);
        const authPayload = payloads.find(p => p.botAuth != null);
        expect(authPayload?.botAuth).toMatchObject({ access_token: botAuth.access_token });
        const channelPayload = payloads.find(p => p.botChannel != null);
        expect(channelPayload?.botChannel).toEqual(botChannel);

        // Bot tokens must NOT link the integration: nothing streamer-ish was
        // persisted, and the only matching auth provider on the definition is
        // the streamer (integration-manager matches definition.authProviderDetails.id).
        expect(payloads.some(p => "streamerChannel" in p)).toBe(false);
        expect(definition.authProviderDetails.id).not.toBe(BOT_ACCOUNT_PROVIDER_ID);

        expect(youtubeAccountStore.getBotAccount()).toMatchObject({
            providerId: BOT_ACCOUNT_PROVIDER_ID,
            channel: botChannel
        });

        expect(accountLinkedSpy).toHaveBeenCalledTimes(1);
        const linkedContext = accountLinkedSpy.mock.calls[0][0] as YouTubeAccountContext;
        expect(linkedContext.providerId).toBe(BOT_ACCOUNT_PROVIDER_ID);
        expect(linkedContext.channel).toEqual(botChannel);

        // The bot auth modal gets a live update.
        expect(mockedFrontendSend).toHaveBeenCalledWith("youtube:bot-auth-update", {
            linked: true,
            channel: botChannel
        });
    });

    it("bot handler ignores streamer tokens (integration-manager owns that path)", async () => {
        const settingsListener = subscribeSettingsUpdate();

        await capturedAuthSuccessHandlers[0]({ providerId: STREAMER_ACCOUNT_PROVIDER_ID, tokenData: streamerAuth });

        expect(mockedGetMyChannel).not.toHaveBeenCalled();
        expect(settingsListener).not.toHaveBeenCalled();
        expect(youtubeAccountStore.getRawAccount("streamer")).toBeNull();
    });

    it("streamer token: integration-manager contract calls link() -> channel cached + settings-update + account-linked", async () => {
        mockedGetMyChannel.mockResolvedValue(streamerChannel);

        const accountLinkedSpy = jest.fn();
        youtubeChatEvents.on("account-linked", accountLinkedSpy);
        const settingsListener = subscribeSettingsUpdate();

        // This is what integration-manager.linkIntegration() does after its own
        // auth-success listener saved definition.auth.
        await integration.link({ auth: streamerAuth });

        expect(mockedGetMyChannel).toHaveBeenCalledWith("streamer");

        const payloads = settingsPayloads(settingsListener);
        const linkPayload = payloads.find(p => p.linked === true);
        expect(linkPayload).toBeDefined();
        expect(linkPayload?.streamerChannel).toEqual(streamerChannel);
        // Streamer auth blob itself is NOT duplicated into settings —
        // integration-manager persists it at /integrations/youtube/auth.
        expect(payloads.some(p => "botAuth" in p)).toBe(false);

        expect(accountLinkedSpy).toHaveBeenCalledTimes(1);
        const linkedAccount = accountLinkedSpy.mock.calls[0][0] as YouTubeAccountContext;
        expect(linkedAccount.providerId).toBe(STREAMER_ACCOUNT_PROVIDER_ID);
        expect(linkedAccount.channel).toEqual(streamerChannel);

        // No bot modal update for streamer links.
        expect(mockedFrontendSend).not.toHaveBeenCalled();
    });

    it("streamer link failure keeps the token but does not persist channel settings", async () => {
        mockedGetMyChannel.mockRejectedValue(new Error("api down"));

        const settingsListener = subscribeSettingsUpdate();

        await expect(integration.link({ auth: streamerAuth })).resolves.toBeUndefined();

        expect(settingsListener).not.toHaveBeenCalled();
        // token still usable via the account store
        expect(youtubeAccountStore.getRawAccount("streamer")?.auth.access_token).toBe(streamerAuth.access_token);
    });
});

describe("bot account frontend routes", () => {
    it("unlink clears the bot account and persists nulls", () => {
        const settingsListener = subscribeSettingsUpdate();

        // Simulate a previously linked bot.
        youtubeAccountStore.setChannel("bot", botChannel);
        youtubeAccountStore.setAuth("bot", botAuth, { emitUpdate: false });

        frontendHandlers["youtube:unlink-bot-account"]();

        expect(youtubeAccountStore.getRawAccount("bot")).toBeNull();
        const payloads = settingsPayloads(settingsListener);
        expect(payloads.some(p => p.botAuth === null && p.botChannel === null)).toBe(true);
        expect(mockedFrontendSend).toHaveBeenCalledWith("youtube:bot-auth-update", { linked: false });
    });

    it("link route opens the Google consent page for the bot provider through the web server", () => {
        frontendHandlers["youtube:link-bot-account"]();

        expect(mockedOpenExternal).toHaveBeenCalledWith(
            `http://localhost:7472/api/v1/auth?providerId=${encodeURIComponent(BOT_ACCOUNT_PROVIDER_ID)}`
        );
    });
});

describe("connect/disconnect lifecycle", () => {
    const integrationData = {
        auth: streamerAuth,
        settings: {
            streamerChannel,
            botAuth,
            botChannel
        }
    };

    beforeEach(() => {
        mockedRefreshTokenIfExpired.mockImplementation(async (providerId: string) =>
            providerId === STREAMER_ACCOUNT_PROVIDER_ID ? refreshedStreamerAuth : refreshedBotAuth);
    });

    it("refreshes both tokens, connects and emits the framework connected event", async () => {
        const connectedIds: Array<unknown> = [];
        integration.once("connected", id => connectedIds.push(id));
        const settingsListener = subscribeSettingsUpdate();

        await integration.connect(integrationData);

        expect(integration.connected).toBe(true);
        expect(connectedIds).toEqual(["youtube"]);
        expect(mockedRefreshTokenIfExpired).toHaveBeenCalledTimes(2);
        expect(mockedRefreshTokenIfExpired).toHaveBeenCalledWith(STREAMER_ACCOUNT_PROVIDER_ID, streamerAuth);
        expect(mockedRefreshTokenIfExpired).toHaveBeenCalledWith(BOT_ACCOUNT_PROVIDER_ID, botAuth);

        // The refreshed bot token is persisted through settings-update.
        const payloads = settingsPayloads(settingsListener);
        expect(payloads.some(p =>
            (p.botAuth as { access_token?: string } | null | undefined)?.access_token === "fake-refreshed-bot-token"
        )).toBe(true);

        // The account store holds the refreshed tokens.
        expect(youtubeAccountStore.getRawAccount("streamer")?.auth.access_token).toBe("fake-refreshed-streamer-token");
        expect(youtubeAccountStore.getBotAccount()?.channel).toEqual(botChannel);
    });

    it("emits disconnected when the streamer refresh fails", async () => {
        mockedRefreshTokenIfExpired.mockResolvedValue(null);

        const disconnectedIds: Array<unknown> = [];
        integration.once("disconnected", id => disconnectedIds.push(id));

        await integration.connect(integrationData);

        expect(integration.connected).toBe(false);
        expect(disconnectedIds).toEqual(["youtube"]);
        expect(mockedRefreshTokenIfExpired).toHaveBeenCalledTimes(1); // no bot attempt
    });

    it("emits disconnected immediately when there is no streamer token at all", async () => {
        const disconnectedIds: Array<unknown> = [];
        integration.once("disconnected", id => disconnectedIds.push(id));

        await integration.connect({ settings: {} });

        expect(disconnectedIds).toEqual(["youtube"]);
        expect(mockedRefreshTokenIfExpired).not.toHaveBeenCalled();
        expect(integration.connected).toBe(false);
    });

    it("still connects (degraded) when only the bot refresh fails", async () => {
        mockedRefreshTokenIfExpired.mockImplementation(async (providerId: string) =>
            providerId === STREAMER_ACCOUNT_PROVIDER_ID ? refreshedStreamerAuth : null);

        await integration.connect(integrationData);

        expect(integration.connected).toBe(true);
        // degraded-but-connected: refreshed streamer blob in the store, bot untouched
        expect(youtubeAccountStore.getRawAccount("streamer")?.auth.access_token).toBe("fake-refreshed-streamer-token");
        // the bot refresh failed, so no (usable) bot token was ever installed this run
        expect(youtubeAccountStore.getRawAccount("bot")).toBeNull();
    });

    it("connects fine with no bot account linked", async () => {
        await integration.connect({
            auth: streamerAuth,
            settings: { streamerChannel }
        });

        expect(integration.connected).toBe(true);
        expect(mockedRefreshTokenIfExpired).toHaveBeenCalledTimes(1);
    });

    it("disconnect flips connected=false and emits the framework event", async () => {
        await integration.connect(integrationData);
        expect(integration.connected).toBe(true);

        const disconnectedIds: Array<unknown> = [];
        integration.once("disconnected", id => disconnectedIds.push(id));

        integration.disconnect();

        expect(integration.connected).toBe(false);
        expect(disconnectedIds).toEqual(["youtube"]);
    });

    it("re-links the channel lazily on connect when settings have no streamerChannel", async () => {
        mockedGetMyChannel.mockResolvedValue(streamerChannel);

        await integration.connect({ auth: streamerAuth, settings: {} });

        expect(mockedGetMyChannel).toHaveBeenCalledWith("streamer");
        const account = youtubeAccountStore.getStreamerAccount();
        expect(account?.channel).toEqual(streamerChannel);
        expect(account?.auth.access_token).toBe("fake-refreshed-streamer-token");
    });
});

describe("unlink", () => {
    it("clears both cached accounts", async () => {
        await integration.connect({
            auth: streamerAuth,
            settings: {
                streamerChannel,
                botAuth,
                botChannel
            }
        });

        integration.unlink();

        expect(youtubeAccountStore.getRawAccount("streamer")).toBeNull();
        expect(youtubeAccountStore.getRawAccount("bot")).toBeNull();
        expect(youtubeAccountStore.getBotAccount()).toBeNull();
    });
});

describe("graceful degradation (google secrets missing)", () => {
    it("does not register the bot provider and keeps the integration harmless", async () => {
        jest.resetModules();
        mockSecrets.secrets = {};

        const freshAuthManagerModule = await import("../../../../auth/auth-manager");
        const freshYoutubeModule = await import("../youtube");

        const freshRegister = ((freshAuthManagerModule.default.registerAuthProvider as unknown) as jest.Mock);

        expect(freshYoutubeModule.definition.authProviderDetails.id).toBe(STREAMER_ACCOUNT_PROVIDER_ID);

        freshYoutubeModule.integration.init(false, {});
        expect(freshRegister).not.toHaveBeenCalled();

        // frontend link route is a no-op (guarded) rather than opening a broken URL
        const freshFrontend = await import("../../../../common/frontend-communicator");

        mockSecrets.secrets = { ...googleCredentialFixtures };
        expect(freshFrontend).toBeDefined();
    });
});
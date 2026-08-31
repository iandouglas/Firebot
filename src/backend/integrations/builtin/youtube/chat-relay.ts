import { EventEmitter } from "events";

import type { FirebotChatMessage } from "../../../../types";

import twitchChatListeners from "../../../chat/chat-listeners/twitch-chat-listeners";
import { platformDispatch } from "../../../chat/platform-dispatch";
import { AccountAccess } from "../../../common/account-access";
import { ConnectionManager } from "../../../common/connection-manager";
import integrationManager from "../../../integrations/integration-manager";
import { LoggerCache } from "../../../logger-cache";

import { youtubeAccountStore } from "./account-store";
import { youTubeChatSender } from "./chat-sender";
import { youtubeChatEvents, type YouTubeIngestMessage } from "./contracts";

const logger = LoggerCache.getLogger("YouTube");

/** YouTube caps regular chat display messages at ~200 characters (see to-do.md facts). */
export const MAX_YOUTUBE_CHAT_LENGTH = 200;
/** Twitch caps chat messages at 500 characters — defensive truncation for YT→Twitch. */
export const MAX_TWITCH_CHAT_LENGTH = 500;
/** Default per-minute relay cap when the setting is missing/invalid. */
export const DEFAULT_RELAY_MAX_PER_MINUTE = 12;
/** Sliding-window length for the per-minute relay cap (D6). */
export const RELAY_WINDOW_MS = 60 * 1000;
/** How often the settings poller checks for a relayEnabled toggle. */
export const SETTINGS_POLL_INTERVAL_MS = 2000;

/**
 * Belt-and-suspenders loop-prevention marker (core invariant #2). Relayed
 * copies are authored by a bot account, so the four-identity self-filter already
 * drops them; this marker is a defensive second check in case a future path
 * tags a message as relayed without it being authored by a known identity.
 */
const RELAY_MARKER = "isRelay";

export interface ChatRelayOptions {
    /** Settings-poll cadence (injectable for tests). */
    pollIntervalMs?: number;
    /** Twitch chat-message emitter (injectable for tests; defaults to twitch-chat-listeners). */
    twitchEvents?: EventEmitter;
    /** YouTube ingest emitter (injectable for tests; defaults to youtubeChatEvents). */
    youtubeEvents?: EventEmitter;
    /** Outbound dispatch (injectable for tests; defaults to platformDispatch). */
    dispatch?: Pick<typeof platformDispatch, "sendChatMessage">;
    /** Clock (injectable for tests; defaults to Date.now). */
    now?: () => number;
}

/** Truncate to `max` chars, appending an ellipsis when cut. */
export function truncate(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    return `${text.slice(0, max - 1)}…`;
}

/**
 * Join the textual parts of a Twitch message. Emote/cheermote/3rd-party parts
 * are dropped per D6 (NOT converted to their text codes); text, link and
 * mention parts are kept.
 */
export function joinTextParts(parts: FirebotChatMessage["parts"]): string {
    if (!Array.isArray(parts)) {
        return "";
    }
    return parts
        .filter((part) => part.type === "text" || part.type === "link" || part.type === "mention")
        .map((part) => part.text)
        .join(" ")
        .trim();
}

/** Twitch→YT relay format: `[Twitch] DisplayName: message`. */
export function formatTwitchToYoutube(msg: FirebotChatMessage): string {
    const displayName = msg.userDisplayName ?? msg.username ?? "";
    return `[Twitch] ${displayName}: ${joinTextParts(msg.parts)}`;
}

/** YT→Twitch relay format: `[YT] DisplayName: message`. */
export function formatYoutubeToTwitch(ingest: YouTubeIngestMessage): string {
    return `[YT] ${ingest.author?.displayName ?? ""}: ${ingest.text ?? ""}`;
}

function hasRelayMarker(value: unknown): boolean {
    return (value as Record<string, unknown> | null)?.[RELAY_MARKER] === true;
}

/**
 * Cross-platform chat relay (WS-6, locked decision D6).
 *
 * Subscribes to both chat sources (Twitch chat-listeners + the YouTube ingest
 * bus) and relays each direction while BOTH platforms are live+connected and
 * the `relayEnabled` setting is on. Loop prevention (core invariant #2) is a
 * four-identity self-filter (twitch streamer/bot usernames + yt streamer/bot
 * channel ids) plus a defensive relay-marker check.
 *
 * A settings poller drives subscribe/unsubscribe: when `relayEnabled` flips off
 * at runtime the listeners are detached cleanly; when it flips back on they are
 * re-attached. Handlers also re-check the setting at send time as a belt.
 */
export class ChatRelay {
    private readonly _pollIntervalMs: number;
    private readonly _twitchEvents: EventEmitter;
    private readonly _youtubeEvents: EventEmitter;
    private readonly _dispatch: Pick<typeof platformDispatch, "sendChatMessage">;
    private readonly _now: () => number;

    private _subscribed = false;
    private _youtubeLive = false;
    private _twitchWindow: number[] = [];
    private _youtubeWindow: number[] = [];
    private _pollTimer: NodeJS.Timeout | null = null;

    constructor(options: ChatRelayOptions = {}) {
        this._pollIntervalMs = options.pollIntervalMs ?? SETTINGS_POLL_INTERVAL_MS;
        this._twitchEvents = options.twitchEvents ?? twitchChatListeners.events;
        this._youtubeEvents = options.youtubeEvents ?? youtubeChatEvents;
        this._dispatch = options.dispatch ?? platformDispatch;
        this._now = options.now ?? Date.now;
        this._startPolling();
    }

    /** True while the relay is actively listening to both chat sources. */
    isSubscribed(): boolean {
        return this._subscribed;
    }

    /** True when the relay would relay a message right now (enabled + both live+connected). */
    isActive(): boolean {
        return this._subscribed
            && this._readRelayEnabled()
            && this._youtubeLive
            && ConnectionManager.chatIsConnected;
    }

    /** Attach chat listeners + the integration-disconnect reset. Idempotent. */
    subscribe(): void {
        if (this._subscribed) {
            return;
        }
        this._subscribed = true;
        // Seed the live flag from the chat-sender so an already-live broadcast
        // is relayed immediately (stream-online may have fired before subscribe).
        this._youtubeLive = youTubeChatSender.isLive();
        this._twitchEvents.on("chat-message", this._handleTwitchMessage);
        this._youtubeEvents.on("chat-message", this._handleYoutubeMessage);
        this._youtubeEvents.on("stream-online", this._handleStreamOnline);
        this._youtubeEvents.on("stream-offline", this._handleStreamOffline);
        integrationManager.on("integration-disconnected", this._handleIntegrationDisconnected);
        logger.debug("Chat relay subscribed.");
    }

    /** Detach chat listeners + the integration-disconnect reset. Idempotent. */
    unsubscribe(): void {
        if (!this._subscribed) {
            return;
        }
        this._subscribed = false;
        this._twitchEvents.off("chat-message", this._handleTwitchMessage);
        this._youtubeEvents.off("chat-message", this._handleYoutubeMessage);
        this._youtubeEvents.off("stream-online", this._handleStreamOnline);
        this._youtubeEvents.off("stream-offline", this._handleStreamOffline);
        integrationManager.off("integration-disconnected", this._handleIntegrationDisconnected);
        logger.debug("Chat relay unsubscribed.");
    }

    /**
     * Settings-poll tick: keep the subscription in sync with `relayEnabled`.
     * Called by the poller; exposed so the integration can force a re-check.
     */
    pollSettings(): void {
        const enabled = this._readRelayEnabled();
        if (enabled && !this._subscribed) {
            this.subscribe();
        } else if (!enabled && this._subscribed) {
            logger.debug("Chat relay disabled at runtime; unsubscribing.");
            this.unsubscribe();
        }
    }

    // --- event handlers (bound so subscribe/unsubscribe can detach them) ---

    private readonly _handleTwitchMessage = (msg: FirebotChatMessage): void => {
        if (!this.isActive()) {
            return;
        }
        if (hasRelayMarker(msg)) {
            return;
        }
        if (this._isSelfAuthorTwitch(msg)) {
            return;
        }
        const text = joinTextParts(msg.parts);
        if (text === "") {
            return;
        }
        const formatted = truncate(formatTwitchToYoutube(msg), MAX_YOUTUBE_CHAT_LENGTH);
        if (!this._withinCap(this._twitchWindow)) {
            logger.debug("Chat relay: Twitch→YT dropped (per-minute cap reached).");
            return;
        }
        this._recordSend(this._twitchWindow);
        void this._dispatch.sendChatMessage(formatted, { destination: "youtube", accountType: "bot" })
            .catch(() => {});
    };

    private readonly _handleYoutubeMessage = (ingest: YouTubeIngestMessage): void => {
        if (!this.isActive()) {
            return;
        }
        if (hasRelayMarker(ingest)) {
            return;
        }
        if (ingest.kind !== "text" || typeof ingest.text !== "string") {
            return;
        }
        if (this._isSelfAuthorYoutube(ingest)) {
            return;
        }
        const text = ingest.text.trim();
        if (text === "") {
            return;
        }
        const formatted = truncate(formatYoutubeToTwitch(ingest), MAX_TWITCH_CHAT_LENGTH);
        if (!this._withinCap(this._youtubeWindow)) {
            logger.debug("Chat relay: YT→Twitch dropped (per-minute cap reached).");
            return;
        }
        this._recordSend(this._youtubeWindow);
        void this._dispatch.sendChatMessage(formatted, { destination: "twitch", accountType: "bot" })
            .catch(() => {});
    };

    private readonly _handleStreamOnline = (): void => {
        this._youtubeLive = true;
    };

    private readonly _handleStreamOffline = (): void => {
        this._youtubeLive = false;
    };

    private readonly _handleIntegrationDisconnected = (id: string): void => {
        if (id === "youtube") {
            this._youtubeLive = false;
        }
    };

    // --- settings (read via the integration's userSettings, same mechanism as AWS/Discord) ---

    private _relaySettings(): { relayEnabled?: boolean; relayMaxPerMinute?: number } | undefined {
        const definition = integrationManager.getIntegrationDefinitionById("youtube") as
            { userSettings?: { relaySettings?: { relayEnabled?: boolean; relayMaxPerMinute?: number } } } | null | undefined;
        return definition?.userSettings?.relaySettings;
    }

    private _readRelayEnabled(): boolean {
        return this._relaySettings()?.relayEnabled === true;
    }

    private _readRelayMaxPerMinute(): number {
        const value = this._relaySettings()?.relayMaxPerMinute;
        const num = Number(value);
        if (Number.isFinite(num) && num >= 0) {
            return Math.floor(num);
        }
        return DEFAULT_RELAY_MAX_PER_MINUTE;
    }

    // --- loop prevention (core invariant #2): the four logged-in identities ---

    private _isSelfAuthorTwitch(msg: FirebotChatMessage): boolean {
        const username = (msg.username ?? "").toLowerCase();
        if (username === "") {
            return false;
        }
        return this._selfIndex().twitchUsernames.has(username);
    }

    private _isSelfAuthorYoutube(ingest: YouTubeIngestMessage): boolean {
        const index = this._selfIndex();
        if (ingest.author?.channelId && index.youtubeChannelIds.has(ingest.author.channelId)) {
            return true;
        }
        const displayName = (ingest.author?.displayName ?? "").toLowerCase();
        return displayName !== "" && index.twitchUsernames.has(displayName);
    }

    private _selfIndex(): { twitchUsernames: Set<string>; youtubeChannelIds: Set<string> } {
        const twitchUsernames = new Set<string>();
        const youtubeChannelIds = new Set<string>();

        const accounts = AccountAccess.getAccounts();
        if (accounts?.streamer?.username) {
            twitchUsernames.add(accounts.streamer.username.toLowerCase());
        }
        if (accounts?.bot?.username) {
            twitchUsernames.add(accounts.bot.username.toLowerCase());
        }

        for (const account of ["streamer", "bot"] as const) {
            const channel = account === "streamer"
                ? youtubeAccountStore.getStreamerAccount()?.channel
                : youtubeAccountStore.getBotAccount()?.channel;
            if (channel?.channelId) {
                youtubeChannelIds.add(channel.channelId);
            }
            if (channel?.channelTitle) {
                // The YT streamer's channel title also matches their own Twitch
                // username in the common "Same Display Name" case.
                twitchUsernames.add(channel.channelTitle.toLowerCase());
            }
        }

        return { twitchUsernames, youtubeChannelIds };
    }

    // --- per-minute sliding-window cap (D6) ---

    private _withinCap(window: number[]): boolean {
        const max = this._readRelayMaxPerMinute();
        const now = this._now();
        const cutoff = now - RELAY_WINDOW_MS;
        while (window.length > 0 && window[0] < cutoff) {
            window.shift();
        }
        return window.length < max;
    }

    private _recordSend(window: number[]): void {
        window.push(this._now());
    }

    // --- settings poller (drives subscribe/unsubscribe on the enabled toggle) ---

    private _startPolling(): void {
        this._stopPolling();
        this._pollTimer = setInterval(() => this.pollSettings(), this._pollIntervalMs);
        if (typeof this._pollTimer.unref === "function") {
            this._pollTimer.unref();
        }
    }

    private _stopPolling(): void {
        if (this._pollTimer != null) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }
}

/**
 * Module singleton. Loaded via a side-effect import from youtube.ts (WS-6
 * wiring) so the settings poller runs for the app's lifetime.
 */
export const chatRelay = new ChatRelay();

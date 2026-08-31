/**
 * WS-6: cross-platform chat relay unit tests.
 *
 * - format + truncation (both directions)
 * - emote/cheermote/3rd-party part stripping on Twitch→YT (D6)
 * - four-identity self-filter (loop prevention, core invariant #2)
 * - per-minute sliding-window cap (D6)
 * - both-live+connected gating
 * - relayEnabled toggle → subscribe/unsubscribe
 * - never-throw on dispatch failure
 *
 * No network; all collaborators mocked. The relay is exercised through fresh
 * `ChatRelay` instances with injected emitters/dispatch/clock so the module
 * singleton never interferes.
 */

jest.mock("../../../../logger-cache", () => ({
    LoggerCache: { getLogger: () => mockLogger }
}));

jest.mock("../../../../common/account-access", () => ({
    AccountAccess: { getAccounts: jest.fn() }
}));

jest.mock("../../../../common/connection-manager", () => ({
    ConnectionManager: {
        get chatIsConnected() {
            return mockChatIsConnected;
        }
    }
}));

jest.mock("../../../../integrations/integration-manager", () => {
    const { EventEmitter } = require("events");
    const manager = new EventEmitter();
    manager.setMaxListeners(100);
    manager.getIntegrationDefinitionById = jest.fn();
    return { __esModule: true, default: manager };
});

jest.mock("../../../../chat/chat-listeners/twitch-chat-listeners", () => {
    const { EventEmitter } = require("events");
    return { __esModule: true, default: { events: new EventEmitter() } };
});

jest.mock("../../../../chat/platform-dispatch", () => ({
    platformDispatch: { sendChatMessage: jest.fn() }
}));

jest.mock("../account-store", () => ({
    youtubeAccountStore: {
        getStreamerAccount: jest.fn(),
        getBotAccount: jest.fn()
    }
}));

jest.mock("../chat-sender", () => ({
    youTubeChatSender: { isLive: jest.fn() }
}));

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

let mockChatIsConnected = false;

import { EventEmitter } from "events";

import { AccountAccess } from "../../../../common/account-access";
import { ConnectionManager } from "../../../../common/connection-manager";
import integrationManager from "../../../../integrations/integration-manager";
import { youtubeAccountStore } from "../account-store";
import { youTubeChatSender } from "../chat-sender";
import type { FirebotChatMessage } from "../../../../../types";
import type { YouTubeIngestMessage } from "../contracts";
import {
    ChatRelay,
    DEFAULT_RELAY_MAX_PER_MINUTE,
    formatTwitchToYoutube,
    formatYoutubeToTwitch,
    joinTextParts,
    MAX_TWITCH_CHAT_LENGTH,
    MAX_YOUTUBE_CHAT_LENGTH,
    truncate
} from "../chat-relay";

const mockGetAccounts = (AccountAccess.getAccounts as unknown) as jest.Mock;
const mockGetStreamerAccount = (youtubeAccountStore.getStreamerAccount as unknown) as jest.Mock;
const mockGetBotAccount = (youtubeAccountStore.getBotAccount as unknown) as jest.Mock;
const mockIsLive = (youTubeChatSender.isLive as unknown) as jest.Mock;
const mockGetIntegrationDefinition = (integrationManager.getIntegrationDefinitionById as unknown) as jest.Mock;

const STREAMER_CHANNEL_ID = "UCstreamerChannelId0001";
const BOT_CHANNEL_ID = "UCbotChannelId0002";
const STREAMER_TITLE = "Firebot Streamer";
const BOT_TITLE = "Firebot Bot";

function setRelaySettings(relayEnabled: boolean, relayMaxPerMinute: number): void {
    mockGetIntegrationDefinition.mockReturnValue({
        userSettings: {
            relaySettings: { relayEnabled, relayMaxPerMinute }
        }
    });
}

function setAccounts(): void {
    mockGetAccounts.mockReturnValue({
        streamer: { username: "streamer", loggedIn: true },
        bot: { username: "bot", loggedIn: true }
    });
    mockGetStreamerAccount.mockReturnValue({
        channel: { channelId: STREAMER_CHANNEL_ID, channelTitle: STREAMER_TITLE, avatarUrl: "" }
    });
    mockGetBotAccount.mockReturnValue({
        channel: { channelId: BOT_CHANNEL_ID, channelTitle: BOT_TITLE, avatarUrl: "" }
    });
}

function twitchMsg(overrides: Partial<FirebotChatMessage> = {}): FirebotChatMessage {
    return {
        id: "twitch-1",
        username: "viewer",
        userId: "123",
        userDisplayName: "Viewer",
        roles: [],
        badges: [],
        rawText: "hello",
        parts: [{ type: "text", text: "hello" }],
        whisper: false,
        action: false,
        tagged: false,
        isSharedChatMessage: false,
        ...overrides
    };
}

function ytMsg(overrides: Partial<YouTubeIngestMessage> = {}): YouTubeIngestMessage {
    return {
        kind: "text",
        messageId: "yt-1",
        author: {
            channelId: "UCviewerChannelId",
            displayName: "Viewer",
            avatarUrl: "",
            isOwner: false,
            isModerator: false,
            isSponsor: false
        },
        text: "hello",
        publishedAt: "2025-01-01T00:00:00Z",
        ...overrides
    };
}

interface RelayHarness {
    relay: ChatRelay;
    twitchEvents: EventEmitter;
    youtubeEvents: EventEmitter;
    dispatch: { sendChatMessage: jest.Mock };
    clock: { now: number };
}

function makeRelay(overrides: { relayEnabled?: boolean; maxPerMinute?: number } = {}): RelayHarness {
    const twitchEvents = new EventEmitter();
    const youtubeEvents = new EventEmitter();
    const dispatch = { sendChatMessage: jest.fn().mockResolvedValue({}) };
    const clock = { now: 1_000_000 };
    const relay = new ChatRelay({
        twitchEvents,
        youtubeEvents,
        dispatch,
        now: () => clock.now,
        pollIntervalMs: 1_000_000 // effectively never fires on its own
    });

    setRelaySettings(overrides.relayEnabled ?? true, overrides.maxPerMinute ?? DEFAULT_RELAY_MAX_PER_MINUTE);
    setAccounts();
    mockIsLive.mockReturnValue(false);
    mockChatIsConnected = true;

    // Make the relay active: enabled + both live+connected.
    relay.subscribe();
    youtubeEvents.emit("stream-online", "video-1", "chat-1");

    return { relay, twitchEvents, youtubeEvents, dispatch, clock };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockChatIsConnected = false;
    mockIsLive.mockReturnValue(false);
    setRelaySettings(false, DEFAULT_RELAY_MAX_PER_MINUTE);
});

describe("format + truncation", () => {
    it("formats Twitch→YT as [Twitch] DisplayName: message", () => {
        expect(formatTwitchToYoutube(twitchMsg({ userDisplayName: "Alice", parts: [{ type: "text", text: "hi there" }] })))
            .toBe("[Twitch] Alice: hi there");
    });

    it("falls back to username when userDisplayName is absent", () => {
        expect(formatTwitchToYoutube(twitchMsg({ userDisplayName: undefined, username: "alice", parts: [{ type: "text", text: "hi" }] })))
            .toBe("[Twitch] alice: hi");
    });

    it("formats YT→Twitch as [YT] DisplayName: message", () => {
        expect(formatYoutubeToTwitch(ytMsg({ author: { ...ytMsg().author, displayName: "Bob" }, text: "yo" })))
            .toBe("[YT] Bob: yo");
    });

    it("truncates to the YouTube 200-char cap with an ellipsis", () => {
        const long = "x".repeat(250);
        const formatted = formatTwitchToYoutube(twitchMsg({ parts: [{ type: "text", text: long }] }));
        const truncated = truncate(formatted, MAX_YOUTUBE_CHAT_LENGTH);
        expect(truncated.length).toBe(MAX_YOUTUBE_CHAT_LENGTH);
        expect(truncated.endsWith("…")).toBe(true);
    });

    it("relays a long Twitch message truncated to 200 chars", () => {
        const { relay, twitchEvents, dispatch } = makeRelay();
        const long = "x".repeat(300);
        twitchEvents.emit("chat-message", twitchMsg({ parts: [{ type: "text", text: long }] }));
        const sent = dispatch.sendChatMessage.mock.calls[0][0] as string;
        expect(sent.length).toBe(MAX_YOUTUBE_CHAT_LENGTH);
        expect(sent.startsWith("[Twitch] Viewer: ")).toBe(true);
        expect(sent.endsWith("…")).toBe(true);
    });

    it("relays a long YT message truncated to the Twitch 500-char cap", () => {
        const { relay, youtubeEvents, dispatch } = makeRelay();
        const long = "y".repeat(600);
        youtubeEvents.emit("chat-message", ytMsg({ text: long }));
        const sent = dispatch.sendChatMessage.mock.calls[0][0] as string;
        expect(sent.length).toBe(MAX_TWITCH_CHAT_LENGTH);
        expect(sent.startsWith("[YT] Viewer: ")).toBe(true);
        expect(sent.endsWith("…")).toBe(true);
    });
});

describe("emote/cheermote/3rd-party part stripping (D6)", () => {
    it("drops emote, cheermote and third-party parts but keeps text/link/mention", () => {
        const parts: FirebotChatMessage["parts"] = [
            { type: "text", text: "hello" },
            { type: "emote", text: "Kappa", name: "Kappa", origin: "twitch", url: "" },
            { type: "cheermote", text: "cheer100", name: "cheer", url: "", animatedUrl: "", amount: 100, color: "red" },
            { type: "third-party-emote", text: "PogChamp", name: "PogChamp", origin: "bttv", url: "" },
            { type: "link", text: "https://example.com", url: "https://example.com" },
            { type: "mention", text: "@bob", username: "bob", userId: "9", userDisplayName: "Bob" },
            { type: "text", text: "!" }
        ];
        expect(joinTextParts(parts)).toBe("hello https://example.com @bob !");
        expect(formatTwitchToYoutube(twitchMsg({ parts }))).toBe("[Twitch] Viewer: hello https://example.com @bob !");
    });

    it("does not convert emote codes into the relayed text", () => {
        const parts: FirebotChatMessage["parts"] = [
            { type: "text", text: "nice" },
            { type: "emote", text: "Kappa", name: "Kappa", origin: "twitch", url: "" }
        ];
        expect(formatTwitchToYoutube(twitchMsg({ parts }))).toBe("[Twitch] Viewer: nice");
    });

    it("skips a message with no textual parts (emotes only)", () => {
        const { relay, twitchEvents, dispatch } = makeRelay();
        twitchEvents.emit("chat-message", twitchMsg({
            parts: [{ type: "emote", text: "Kappa", name: "Kappa", origin: "twitch", url: "" }]
        }));
        expect(dispatch.sendChatMessage).not.toHaveBeenCalled();
    });
});

describe("four-identity self-filter (loop prevention)", () => {
    it("does not relay a Twitch message from the twitch streamer", () => {
        const { relay, twitchEvents, dispatch } = makeRelay();
        twitchEvents.emit("chat-message", twitchMsg({ username: "streamer", userDisplayName: "Streamer" }));
        expect(dispatch.sendChatMessage).not.toHaveBeenCalled();
    });

    it("does not relay a Twitch message from the twitch bot", () => {
        const { relay, twitchEvents, dispatch } = makeRelay();
        twitchEvents.emit("chat-message", twitchMsg({ username: "bot", userDisplayName: "Bot" }));
        expect(dispatch.sendChatMessage).not.toHaveBeenCalled();
    });

    it("does not relay a Twitch message whose username matches the YT streamer channel title", () => {
        const { relay, twitchEvents, dispatch } = makeRelay();
        twitchEvents.emit("chat-message", twitchMsg({ username: STREAMER_TITLE.toLowerCase(), userDisplayName: STREAMER_TITLE }));
        expect(dispatch.sendChatMessage).not.toHaveBeenCalled();
    });

    it("does not relay a YT message from the yt streamer channel id", () => {
        const { relay, youtubeEvents, dispatch } = makeRelay();
        youtubeEvents.emit("chat-message", ytMsg({ author: { ...ytMsg().author, channelId: STREAMER_CHANNEL_ID } }));
        expect(dispatch.sendChatMessage).not.toHaveBeenCalled();
    });

    it("does not relay a YT message from the yt bot channel id", () => {
        const { relay, youtubeEvents, dispatch } = makeRelay();
        youtubeEvents.emit("chat-message", ytMsg({ author: { ...ytMsg().author, channelId: BOT_CHANNEL_ID } }));
        expect(dispatch.sendChatMessage).not.toHaveBeenCalled();
    });

    it("does not relay a YT message whose display name matches the twitch streamer username", () => {
        const { relay, youtubeEvents, dispatch } = makeRelay();
        youtubeEvents.emit("chat-message", ytMsg({ author: { ...ytMsg().author, displayName: "streamer" } }));
        expect(dispatch.sendChatMessage).not.toHaveBeenCalled();
    });

    it("relays a normal viewer message in both directions", () => {
        const { relay, twitchEvents, youtubeEvents, dispatch } = makeRelay();
        twitchEvents.emit("chat-message", twitchMsg());
        youtubeEvents.emit("chat-message", ytMsg());
        expect(dispatch.sendChatMessage).toHaveBeenCalledTimes(2);
    });

    it("skips a message carrying the relay marker (belt-and-suspenders)", () => {
        const { relay, twitchEvents, dispatch } = makeRelay();
        const msg = twitchMsg() as FirebotChatMessage & { isRelay?: boolean };
        msg.isRelay = true;
        twitchEvents.emit("chat-message", msg);
        expect(dispatch.sendChatMessage).not.toHaveBeenCalled();
    });
});

describe("per-minute sliding-window cap (D6)", () => {
    it("drops messages beyond the cap within the window and allows them after it slides", () => {
        const { relay, twitchEvents, dispatch, clock } = makeRelay({ maxPerMinute: 2 });

        twitchEvents.emit("chat-message", twitchMsg({ id: "a" }));
        twitchEvents.emit("chat-message", twitchMsg({ id: "b" }));
        twitchEvents.emit("chat-message", twitchMsg({ id: "c" }));
        expect(dispatch.sendChatMessage).toHaveBeenCalledTimes(2);

        // Slide the window past 60s — the cap resets.
        clock.now += 60_001;
        twitchEvents.emit("chat-message", twitchMsg({ id: "d" }));
        expect(dispatch.sendChatMessage).toHaveBeenCalledTimes(3);
    });

    it("enforces the cap independently per direction", () => {
        const { relay, twitchEvents, youtubeEvents, dispatch } = makeRelay({ maxPerMinute: 1 });

        twitchEvents.emit("chat-message", twitchMsg({ id: "t1" }));
        twitchEvents.emit("chat-message", twitchMsg({ id: "t2" }));
        youtubeEvents.emit("chat-message", ytMsg({ messageId: "y1" }));
        youtubeEvents.emit("chat-message", ytMsg({ messageId: "y2" }));

        // One send per direction (each direction has its own window).
        expect(dispatch.sendChatMessage).toHaveBeenCalledTimes(2);
        const destinations = dispatch.sendChatMessage.mock.calls.map((c) => c[1].destination);
        expect(destinations).toContain("youtube");
        expect(destinations).toContain("twitch");
    });
});

describe("both-live+connected gating", () => {
    it("does not relay when Twitch chat is not connected", () => {
        const { relay, twitchEvents, youtubeEvents, dispatch } = makeRelay();
        mockChatIsConnected = false;
        twitchEvents.emit("chat-message", twitchMsg());
        youtubeEvents.emit("chat-message", ytMsg());
        expect(dispatch.sendChatMessage).not.toHaveBeenCalled();
    });

    it("does not relay when YouTube is not live", () => {
        const { relay, twitchEvents, youtubeEvents, dispatch } = makeRelay();
        youtubeEvents.emit("stream-offline");
        twitchEvents.emit("chat-message", twitchMsg());
        youtubeEvents.emit("chat-message", ytMsg());
        expect(dispatch.sendChatMessage).not.toHaveBeenCalled();
    });

    it("relays when both platforms are live+connected", () => {
        const { relay, twitchEvents, youtubeEvents, dispatch } = makeRelay();
        twitchEvents.emit("chat-message", twitchMsg());
        youtubeEvents.emit("chat-message", ytMsg());
        expect(dispatch.sendChatMessage).toHaveBeenCalledTimes(2);
    });

    it("stops relaying when the YouTube integration disconnects", () => {
        const { relay, twitchEvents, dispatch } = makeRelay();
        integrationManager.emit("integration-disconnected", "youtube");
        twitchEvents.emit("chat-message", twitchMsg());
        expect(dispatch.sendChatMessage).not.toHaveBeenCalled();
    });
});

describe("relayEnabled toggle → subscribe/unsubscribe", () => {
    it("starts unsubscribed when relayEnabled is off", () => {
        const relay = new ChatRelay({ pollIntervalMs: 1_000_000 });
        setRelaySettings(false, DEFAULT_RELAY_MAX_PER_MINUTE);
        expect(relay.isSubscribed()).toBe(false);
    });

    it("subscribes when relayEnabled flips on and unsubscribes when it flips off", () => {
        const twitchEvents = new EventEmitter();
        const youtubeEvents = new EventEmitter();
        const dispatch = { sendChatMessage: jest.fn().mockResolvedValue({}) };
        const relay = new ChatRelay({ twitchEvents, youtubeEvents, dispatch, pollIntervalMs: 1_000_000 });

        setRelaySettings(false, DEFAULT_RELAY_MAX_PER_MINUTE);
        expect(relay.isSubscribed()).toBe(false);

        setRelaySettings(true, DEFAULT_RELAY_MAX_PER_MINUTE);
        relay.pollSettings();
        expect(relay.isSubscribed()).toBe(true);

        // While subscribed + active, a message is relayed.
        mockChatIsConnected = true;
        youtubeEvents.emit("stream-online", "v", "c");
        twitchEvents.emit("chat-message", twitchMsg());
        expect(dispatch.sendChatMessage).toHaveBeenCalledTimes(1);

        setRelaySettings(false, DEFAULT_RELAY_MAX_PER_MINUTE);
        relay.pollSettings();
        expect(relay.isSubscribed()).toBe(false);

        // After unsubscribe, listeners are detached — no relay.
        twitchEvents.emit("chat-message", twitchMsg());
        expect(dispatch.sendChatMessage).toHaveBeenCalledTimes(1);
    });

    it("is idempotent for repeated subscribe/unsubscribe", () => {
        const relay = new ChatRelay({ pollIntervalMs: 1_000_000 });
        setRelaySettings(true, DEFAULT_RELAY_MAX_PER_MINUTE);
        relay.subscribe();
        relay.subscribe();
        expect(relay.isSubscribed()).toBe(true);
        relay.unsubscribe();
        relay.unsubscribe();
        expect(relay.isSubscribed()).toBe(false);
    });
});

describe("never-throw on dispatch failure", () => {
    it("does not throw when the dispatch rejects", async () => {
        const { relay, twitchEvents, youtubeEvents, dispatch } = makeRelay();
        dispatch.sendChatMessage.mockRejectedValue(new Error("boom"));

        expect(() => {
            twitchEvents.emit("chat-message", twitchMsg());
            youtubeEvents.emit("chat-message", ytMsg());
        }).not.toThrow();

        // Give the (void) promises a chance to settle.
        await Promise.resolve();
        await Promise.resolve();
        expect(dispatch.sendChatMessage).toHaveBeenCalledTimes(2);
    });
});

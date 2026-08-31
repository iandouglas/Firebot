/**
 * WS-4: YouTube chat ingest reader.
 *
 * - LOCKED signatures (WS-2 handoff): startChatIngest(liveChatId, videoId) /
 *   stopChatIngest() — arity + idempotency asserted here.
 * - Reader loop: pagination, pollingIntervalMillis respect, nextPageToken chain,
 *   in-memory message-id dedupe.
 * - Routing: text → frontend feed + active-user presence + viewer-DB accrual +
 *   command handling (self-filtered for the four logged-in identities);
 *   non-text kinds → ingest bus only; sponsorOnlyMode* → WS-7 trigger;
 *   chatEnded/offlineAt → clean stop + "stream-offline".
 * - Error taxonomy: transient backoff (max 3) then monitor cadence; auth/quota/
 *   not-found stop without emitting.
 *
 * No network; all collaborators mocked. The real `youtubeChatEvents` emitter
 * and the real `chat-message-mapper` are exercised.
 */

jest.mock("../../../../logger-cache", () => ({
    LoggerCache: { getLogger: () => mockLogger }
}));

jest.mock("../../../../common/account-access", () => ({
    AccountAccess: { getAccounts: jest.fn() }
}));

jest.mock("../../../../chat/frontend-chat-manager", () => ({
    FrontendChatManager: { sendChatMessageToFrontend: jest.fn() }
}));

jest.mock("../../../../chat/commands/chat-command-handler", () => ({
    __esModule: true,
    default: { handleChatMessage: jest.fn() }
}));

jest.mock("../../../../chat/active-user-handler", () => ({
    ActiveUserHandler: { addYouTubeActiveUser: jest.fn() }
}));

jest.mock("../../../../viewers/viewer-database", () => ({
    __esModule: true,
    default: {
        isViewerDBOn: jest.fn(),
        upsertYouTubeViewer: jest.fn(),
        incrementDbField: jest.fn()
    }
}));

jest.mock("../../../../viewers/viewer-online-status-manager", () => ({
    __esModule: true,
    default: { setChatViewerOnline: jest.fn() }
}));

jest.mock("../../../../viewers/viewer-identity", () => ({
    scopeViewerId: jest.fn((platform: string, id: string) => `${platform}:${id}`)
}));

jest.mock("../account-store", () => ({
    youtubeAccountStore: {
        getRawAccount: jest.fn(),
        getStreamerAccount: jest.fn(),
        getBotAccount: jest.fn()
    }
}));

jest.mock("../youtube-api-client", () => ({
    youTubeApiClient: { listChatMessages: jest.fn() }
}));

jest.mock("../events/event-handler", () => ({
    triggerMembersOnlyMode: jest.fn()
}));

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

import { AccountAccess } from "../../../../common/account-access";
import { FrontendChatManager } from "../../../../chat/frontend-chat-manager";
import chatCommandHandler from "../../../../chat/commands/chat-command-handler";
import { ActiveUserHandler } from "../../../../chat/active-user-handler";
import viewerDatabase from "../../../../viewers/viewer-database";
import viewerOnlineStatusManager from "../../../../viewers/viewer-online-status-manager";

import { youtubeAccountStore } from "../account-store";
import { YouTubeApiError, youtubeChatEvents, type YouTubeChatAuthor, type YouTubeChatMessageItem, type YouTubeChatMessageList } from "../contracts";
import { triggerMembersOnlyMode } from "../events/event-handler";
import { youTubeApiClient } from "../youtube-api-client";
import { isChatIngestRunning, startChatIngest, stopChatIngest } from "../chat-ingest";

const mockListChatMessages = (youTubeApiClient.listChatMessages as unknown) as jest.Mock;
const mockGetRawAccount = (youtubeAccountStore.getRawAccount as unknown) as jest.Mock;
const mockGetStreamerAccount = (youtubeAccountStore.getStreamerAccount as unknown) as jest.Mock;
const mockGetBotAccount = (youtubeAccountStore.getBotAccount as unknown) as jest.Mock;
const mockGetAccounts = (AccountAccess.getAccounts as unknown) as jest.Mock;
const mockSendToFrontend = (FrontendChatManager.sendChatMessageToFrontend as unknown) as jest.Mock;
const mockHandleChatMessage = (chatCommandHandler.handleChatMessage as unknown) as jest.Mock;
const mockAddYouTubeActiveUser = (ActiveUserHandler.addYouTubeActiveUser as unknown) as jest.Mock;
const mockIsViewerDBOn = (viewerDatabase.isViewerDBOn as unknown) as jest.Mock;
const mockUpsertYouTubeViewer = (viewerDatabase.upsertYouTubeViewer as unknown) as jest.Mock;
const mockIncrementDbField = (viewerDatabase.incrementDbField as unknown) as jest.Mock;
const mockSetChatViewerOnline = (viewerOnlineStatusManager.setChatViewerOnline as unknown) as jest.Mock;
const mockTriggerMembersOnlyMode = (triggerMembersOnlyMode as unknown) as jest.Mock;

let emitSpy: jest.SpyInstance;

const LIVE_CHAT_ID = "chat-1";
const VIDEO_ID = "video-1";

type TextItemOverrides = Partial<Omit<YouTubeChatMessageItem, "author">> & { author?: Partial<YouTubeChatAuthor> };

function textItem(id: string, overrides: TextItemOverrides = {}, text = "hello"): YouTubeChatMessageItem {
    const channelId = overrides.author?.channelId ?? "UCviewer";
    const displayName = overrides.author?.displayName ?? "Viewer";
    return {
        id,
        type: "textMessageEvent",
        publishedAt: "2026-01-01T12:00:00Z",
        displayMessage: text,
        authorChannelId: channelId,
        details: { textMessageDetails: { messageText: text } },
        ...overrides,
        author: {
            channelId,
            displayName,
            avatarUrl: "https://example.com/avatar.png",
            isVerified: false,
            isChatOwner: false,
            isChatModerator: false,
            isChatSponsor: false,
            ...(overrides.author ?? {})
        }
    };
}

function list(messages: YouTubeChatMessageItem[] = [], overrides: Partial<YouTubeChatMessageList> = {}): YouTubeChatMessageList {
    return {
        liveChatId: LIVE_CHAT_ID,
        messages,
        nextPageToken: "next",
        pollingIntervalMillis: 5000,
        ...overrides
    };
}

async function flush(times = 20): Promise<void> {
    for (let i = 0; i < times; i++) {
        await Promise.resolve();
    }
}

async function advance(ms: number): Promise<void> {
    jest.advanceTimersByTime(ms);
    await flush();
}

function chatMessageEmits(): Array<[string, unknown]> {
    return emitSpy.mock.calls.filter(call => call[0] === "chat-message");
}

function offlineEmits(): number {
    return emitSpy.mock.calls.filter(call => call[0] === "stream-offline").length;
}

beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    stopChatIngest();

    mockListChatMessages.mockResolvedValue(list([]));
    mockGetRawAccount.mockReturnValue(null);
    mockGetStreamerAccount.mockReturnValue(null);
    mockGetBotAccount.mockReturnValue(null);
    mockGetAccounts.mockReturnValue({ streamer: { username: "" }, bot: { username: "" } });
    mockSendToFrontend.mockReturnValue(undefined);
    mockHandleChatMessage.mockResolvedValue({ ranCommand: false });
    mockAddYouTubeActiveUser.mockResolvedValue(undefined);
    mockIsViewerDBOn.mockReturnValue(false);
    mockUpsertYouTubeViewer.mockResolvedValue(null);
    mockIncrementDbField.mockResolvedValue(undefined);
    mockSetChatViewerOnline.mockResolvedValue(undefined);
    mockTriggerMembersOnlyMode.mockReturnValue(undefined);

    emitSpy = jest.spyOn(youtubeChatEvents, "emit");
});

afterEach(() => {
    stopChatIngest();
    emitSpy?.mockRestore();
    jest.useRealTimers();
});

describe("chat-ingest locked signatures (WS-2 handoff)", () => {
    it("exports startChatIngest with the locked signature (liveChatId, videoId) -> void", () => {
        expect(typeof startChatIngest).toBe("function");
        expect(startChatIngest.length).toBe(2);
    });

    it("exports stopChatIngest with the locked signature () -> void", () => {
        expect(typeof stopChatIngest).toBe("function");
        expect(stopChatIngest.length).toBe(0);
    });

    it("both are safe no-ops until a broadcast is live", () => {
        expect(() => startChatIngest("chat-1", "video-1")).not.toThrow();
        expect(() => stopChatIngest()).not.toThrow();
        expect(() => stopChatIngest()).not.toThrow(); // idempotent by contract
        expect(startChatIngest("chat-1", "video-1")).toBeUndefined();
        expect(stopChatIngest()).toBeUndefined();
    });

    it("ignores start calls with missing liveChatId or videoId", () => {
        expect(() => startChatIngest("", "video-1")).not.toThrow();
        expect(() => startChatIngest("chat-1", "")).not.toThrow();
        expect(isChatIngestRunning()).toBe(false);
    });
});

describe("reader loop", () => {
    it("polls listChatMessages with the streamer account and liveChatId", async () => {
        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);
        expect(mockListChatMessages).toHaveBeenCalledWith("streamer", LIVE_CHAT_ID, undefined);
    });

    it("waits pollingIntervalMillis between polls", async () => {
        mockListChatMessages.mockResolvedValue(list([], { pollingIntervalMillis: 3000 }));
        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);
        expect(mockListChatMessages).toHaveBeenCalledTimes(1);

        await advance(2999);
        expect(mockListChatMessages).toHaveBeenCalledTimes(1);

        await advance(1);
        expect(mockListChatMessages).toHaveBeenCalledTimes(2);
    });

    it("falls back to 5000ms when pollingIntervalMillis is missing", async () => {
        mockListChatMessages.mockResolvedValue(list([], { pollingIntervalMillis: undefined }));
        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);
        await advance(4999);
        expect(mockListChatMessages).toHaveBeenCalledTimes(1);
        await advance(1);
        expect(mockListChatMessages).toHaveBeenCalledTimes(2);
    });

    it("chains nextPageToken across polls", async () => {
        mockListChatMessages
            .mockResolvedValueOnce(list([], { nextPageToken: "token-1" }))
            .mockResolvedValueOnce(list([], { nextPageToken: "token-2" }));

        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);
        expect(mockListChatMessages).toHaveBeenLastCalledWith("streamer", LIVE_CHAT_ID, undefined);

        await advance(5000);
        expect(mockListChatMessages).toHaveBeenLastCalledWith("streamer", LIVE_CHAT_ID, "token-1");
    });

    it("dedupes by message id across polls", async () => {
        const item = textItem("dedupe-1", { author: { channelId: "UCviewer", displayName: "Viewer" } });
        mockListChatMessages
            .mockResolvedValueOnce(list([item]))
            .mockResolvedValueOnce(list([item])); // same message again

        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);
        await advance(5000);

        expect(chatMessageEmits()).toHaveLength(1);
        expect(mockSendToFrontend).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when started with the same liveChatId/videoId while running", async () => {
        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);
        expect(mockListChatMessages).toHaveBeenCalledTimes(1);

        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);
        expect(mockListChatMessages).toHaveBeenCalledTimes(1);
    });

    it("replaces an existing loop when started with a different liveChatId", async () => {
        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);
        expect(mockListChatMessages).toHaveBeenLastCalledWith("streamer", LIVE_CHAT_ID, undefined);

        startChatIngest("chat-2", "video-2");
        await advance(0);
        expect(mockListChatMessages).toHaveBeenLastCalledWith("streamer", "chat-2", undefined);
    });
});

describe("routing", () => {
    it("emits text messages on the ingest bus and renders them to the frontend feed", async () => {
        const item = textItem("emit-1", { author: { channelId: "UCviewer", displayName: "Viewer" } }, "hello");
        mockListChatMessages.mockResolvedValue(list([item]));

        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);
        await flush();

        const emits = chatMessageEmits();
        expect(emits).toHaveLength(1);
        expect(emits[0][1]).toMatchObject({ kind: "text", messageId: "emit-1" });
        expect(mockSendToFrontend).toHaveBeenCalledTimes(1);
        expect(mockSendToFrontend.mock.calls[0][0]).toMatchObject({
            platform: "youtube",
            userId: "UCviewer",
            userDisplayName: "Viewer"
        });
    });

    it("registers YouTube chatters with the active user handler (platform-tagged)", async () => {
        const item = textItem("presence-1", { author: { channelId: "UCviewer", displayName: "Viewer" } }, "hello");
        mockListChatMessages.mockResolvedValue(list([item]));

        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);
        await flush();

        expect(mockAddYouTubeActiveUser).toHaveBeenCalledWith(expect.objectContaining({
            id: "UCviewer",
            username: "viewer",
            displayName: "Viewer",
            roles: []
        }));
    });

    it("emits non-text kinds on the ingest bus without rendering them as chat", async () => {
        const superChat: YouTubeChatMessageItem = {
            id: "sc-1",
            type: "superChatEvent",
            publishedAt: "2026-01-01T12:00:00Z",
            displayMessage: "Great stream!",
            authorChannelId: "UCviewer",
            author: {
                channelId: "UCviewer",
                displayName: "Viewer",
                avatarUrl: "",
                isVerified: false,
                isChatOwner: false,
                isChatModerator: false,
                isChatSponsor: true
            },
            details: { superChatDetails: { amountDisplayString: "$5.00", amountMicros: "5000000", currency: "USD", tier: 2 } }
        };
        mockListChatMessages.mockResolvedValue(list([superChat]));

        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);

        const emits = chatMessageEmits();
        expect(emits).toHaveLength(1);
        expect(emits[0][1]).toMatchObject({ kind: "super-chat" });
        expect(mockSendToFrontend).not.toHaveBeenCalled();
    });

    it("calls WS-7 triggerMembersOnlyMode for sponsorOnlyMode snippet types", async () => {
        const startedItem: YouTubeChatMessageItem = {
            id: "mode-1",
            type: "sponsorOnlyModeStartedEvent",
            publishedAt: "2026-01-01T12:00:00Z",
            displayMessage: "",
            authorChannelId: "",
            author: { channelId: "", displayName: "", avatarUrl: "", isVerified: false, isChatOwner: false, isChatModerator: false, isChatSponsor: false },
            details: {}
        };
        mockListChatMessages.mockResolvedValue(list([startedItem]));
        mockGetStreamerAccount.mockReturnValue({ channel: { channelId: "UCytstreamer", channelTitle: "YT Streamer" } });

        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);

        expect(mockTriggerMembersOnlyMode).toHaveBeenCalledWith(true, { channelId: "UCytstreamer", channelTitle: "YT Streamer" });
        expect(chatMessageEmits()).toHaveLength(0);
    });
});

describe("self-filter (invariant #2)", () => {
    beforeEach(() => {
        mockGetRawAccount.mockImplementation((account: string) => {
            if (account === "streamer") {
                return { channel: { channelId: "UCytstreamer", channelTitle: "YT Streamer" } };
            }
            if (account === "bot") {
                return { channel: { channelId: "UCytbot", channelTitle: "YT Bot" } };
            }
            return null;
        });
        mockGetAccounts.mockReturnValue({
            streamer: { username: "twitchstreamer" },
            bot: { username: "twitchbot" }
        });
    });

    it("skips command processing for all four logged-in identities but still shows them in the feed", async () => {
        const identities = [
            textItem("self-1", { author: { channelId: "UCytstreamer", displayName: "YT Streamer" } }),
            textItem("self-2", { author: { channelId: "UCytbot", displayName: "YT Bot" } }),
            textItem("self-3", { author: { channelId: "UCtwitchstreamer", displayName: "TwitchStreamer" } }),
            textItem("self-4", { author: { channelId: "UCtwitchbot", displayName: "TwitchBot" } }),
            textItem("self-5", { author: { channelId: "UCviewer", displayName: "Viewer" } })
        ];
        mockListChatMessages.mockResolvedValue(list(identities));

        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);
        await flush();

        // All five still render in the blended dashboard feed.
        expect(mockSendToFrontend).toHaveBeenCalledTimes(5);
        // Only the non-self message reaches command handling.
        expect(mockHandleChatMessage).toHaveBeenCalledTimes(1);
        expect(mockHandleChatMessage.mock.calls[0][0].userId).toBe("UCviewer");
    });
});

describe("viewer-DB accrual", () => {
    it("throttles viewer upserts to once per 60s per user and increments chatMessages every time", async () => {
        mockIsViewerDBOn.mockReturnValue(true);
        mockUpsertYouTubeViewer.mockResolvedValue({ _id: "youtube:UCthrottleviewer" });
        mockIncrementDbField.mockResolvedValue(undefined);
        mockSetChatViewerOnline.mockResolvedValue(undefined);

        const item1 = textItem("accrue-1", { author: { channelId: "UCthrottleviewer", displayName: "Throttle" } }, "one");
        mockListChatMessages.mockResolvedValue(list([item1]));

        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);
        await flush();
        expect(mockUpsertYouTubeViewer).toHaveBeenCalledTimes(1);
        expect(mockIncrementDbField).toHaveBeenCalledWith("youtube:UCthrottleviewer", "chatMessages");

        // Second message from the same user within 60s -> no upsert, still increments.
        const item2 = textItem("accrue-2", { author: { channelId: "UCthrottleviewer", displayName: "Throttle" } }, "two");
        mockListChatMessages.mockResolvedValue(list([item2]));
        await advance(5000);
        await flush();
        expect(mockUpsertYouTubeViewer).toHaveBeenCalledTimes(1);
        expect(mockIncrementDbField).toHaveBeenCalledTimes(2);

        // Advance past the 60s throttle window -> upsert again.
        jest.setSystemTime(Date.now() + 60000);
        const item3 = textItem("accrue-3", { author: { channelId: "UCthrottleviewer", displayName: "Throttle" } }, "three");
        mockListChatMessages.mockResolvedValue(list([item3]));
        await advance(5000);
        await flush();
        expect(mockUpsertYouTubeViewer).toHaveBeenCalledTimes(2);
    });
});

describe("terminal + transient behavior (invariant #4)", () => {
    it("stops and emits stream-offline when offlineAt is present", async () => {
        mockListChatMessages.mockResolvedValue(list([], { offlineAt: "2026-01-01T13:00:00Z" }));

        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);

        expect(offlineEmits()).toBe(1);
        expect(isChatIngestRunning()).toBe(false);
        await advance(5000);
        expect(mockListChatMessages).toHaveBeenCalledTimes(1);
    });

    it("stops and emits stream-offline when a chatEndedEvent item appears", async () => {
        const endedItem: YouTubeChatMessageItem = {
            id: "ended-1",
            type: "chatEndedEvent",
            publishedAt: "2026-01-01T12:00:00Z",
            displayMessage: "",
            authorChannelId: "",
            author: { channelId: "", displayName: "", avatarUrl: "", isVerified: false, isChatOwner: false, isChatModerator: false, isChatSponsor: false },
            details: {}
        };
        mockListChatMessages.mockResolvedValue(list([endedItem]));

        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);

        expect(offlineEmits()).toBe(1);
        expect(isChatIngestRunning()).toBe(false);
    });

    it("stops and emits stream-offline on a chat-ended API error", async () => {
        mockListChatMessages.mockRejectedValue(new YouTubeApiError("chat-ended", "chat ended"));

        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);

        expect(offlineEmits()).toBe(1);
        expect(isChatIngestRunning()).toBe(false);
    });

    it("stops without emitting stream-offline on auth/quota/not-found errors", async () => {
        mockListChatMessages.mockRejectedValue(new YouTubeApiError("auth", "no token"));

        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0);

        expect(offlineEmits()).toBe(0);
        expect(isChatIngestRunning()).toBe(false);
    });

    it("backs off exponentially on transient errors then falls back to the monitor cadence with a fresh token", async () => {
        mockListChatMessages.mockRejectedValue(new YouTubeApiError("other", "network"));

        startChatIngest(LIVE_CHAT_ID, VIDEO_ID);
        await advance(0); // attempt 1 -> backoff 2000
        expect(mockListChatMessages).toHaveBeenCalledTimes(1);

        await advance(2000); // attempt 2 -> backoff 4000
        expect(mockListChatMessages).toHaveBeenCalledTimes(2);

        await advance(4000); // attempt 3 -> give up to monitor cadence (60s)
        expect(mockListChatMessages).toHaveBeenCalledTimes(3);

        await advance(60000); // monitor cadence -> fresh page token
        expect(mockListChatMessages).toHaveBeenCalledTimes(4);
        expect(mockListChatMessages).toHaveBeenLastCalledWith("streamer", LIVE_CHAT_ID, undefined);
    });
});

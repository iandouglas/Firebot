/**
 * WS-8: YouTube moderation unit tests — live-chat-id tracking, delete/timeout/
 * ban/unban via the STREAMER (owner) account token, timeout clamping, and the
 * frontend handler registration. All collaborators are mocked; no network.
 */

jest.mock("../../../../auth/auth-manager", () => ({
    __esModule: true,
    default: {
        refreshTokenIfExpired: jest.fn()
    }
}));

jest.mock("../../../../secrets-manager", () => ({
    SecretsManager: { secrets: {} }
}));

jest.mock("../../../../logger-cache", () => ({
    LoggerCache: { getLogger: () => mockLogger }
}));

jest.mock("../../../../common/frontend-communicator", () => ({
    __esModule: true,
    default: {
        on: jest.fn(),
        onAsync: jest.fn(),
        send: jest.fn()
    }
}));

jest.mock("../youtube-api-client", () => ({
    youTubeApiClient: {
        deleteChatMessage: jest.fn(),
        banUser: jest.fn(),
        unbanUser: jest.fn()
    }
}));

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

import frontendCommunicator from "../../../../common/frontend-communicator";
import { YouTubeApiError, youtubeChatEvents } from "../contracts";
import {
    DEFAULT_TIMEOUT_SECONDS,
    MAX_TIMEOUT_SECONDS,
    MIN_TIMEOUT_SECONDS,
    YouTubeModeration,
    youTubeModeration
} from "../moderation";
import { youTubeApiClient } from "../youtube-api-client";

const mockDeleteChatMessage = (youTubeApiClient.deleteChatMessage as unknown) as jest.Mock;
const mockBanUser = (youTubeApiClient.banUser as unknown) as jest.Mock;
const mockUnbanUser = (youTubeApiClient.unbanUser as unknown) as jest.Mock;
const mockOnAsync = (frontendCommunicator.onAsync as unknown) as jest.Mock;

const LIVE_CHAT_ID = "Cg0KC0Zha2VDaGF0SWT4AyAB";
const VIDEO_ID = "fakeVideoIdBroadcast1";
const MESSAGE_ID = "fakeChatMessage1";
const CHANNEL_ID = "UCfakeAuthorChannelId";

let moderation: YouTubeModeration;

beforeEach(() => {
    mockDeleteChatMessage.mockResolvedValue(undefined);
    mockBanUser.mockResolvedValue(undefined);
    mockUnbanUser.mockResolvedValue(undefined);
    mockOnAsync.mockClear();
    moderation = new YouTubeModeration();
});

describe("YouTube moderation", () => {
    describe("live chat id tracking", () => {
        it("is not live until a stream-online event provides a live chat id", () => {
            expect(moderation.isLive()).toBe(false);
            expect(moderation.getLiveChatId()).toBeNull();
        });

        it("caches the live chat id from the stream-online event", () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);
            expect(moderation.isLive()).toBe(true);
            expect(moderation.getLiveChatId()).toBe(LIVE_CHAT_ID);
        });

        it("tolerates a stream-online event without a live chat id", () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, undefined);
            expect(moderation.isLive()).toBe(false);
        });

        it("clears the live chat id on stream-offline so actions skip again", () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);
            youtubeChatEvents.emit("stream-offline");
            expect(moderation.isLive()).toBe(false);
            expect(moderation.getLiveChatId()).toBeNull();
        });
    });

    describe("deleteMessage", () => {
        it("deletes a message with the streamer (owner) account token", async () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);
            const result = await moderation.deleteMessage(MESSAGE_ID);

            expect(result.success).toBe(true);
            expect(mockDeleteChatMessage).toHaveBeenCalledWith("streamer", MESSAGE_ID);
        });

        it("rejects a missing message id without calling the api", async () => {
            const result = await moderation.deleteMessage(null);

            expect(result.success).toBe(false);
            expect(mockDeleteChatMessage).not.toHaveBeenCalled();
        });

        it("returns an error result (never throws) on a YouTubeApiError", async () => {
            mockDeleteChatMessage.mockRejectedValue(
                new YouTubeApiError("quota", "quota exceeded", { account: "streamer" })
            );
            const result = await moderation.deleteMessage(MESSAGE_ID);

            expect(result.success).toBe(false);
            expect(result.error).toContain("quota");
        });
    });

    describe("timeoutUser", () => {
        it("times out a user with the streamer token and a temporary ban", async () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);
            const result = await moderation.timeoutUser(CHANNEL_ID, 300);

            expect(result.success).toBe(true);
            expect(mockBanUser).toHaveBeenCalledWith("streamer", LIVE_CHAT_ID, CHANNEL_ID, {
                type: "temporary",
                durationSecs: 300
            });
        });

        it("clamps durations below the 30s minimum", async () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);
            await moderation.timeoutUser(CHANNEL_ID, 5);

            expect(mockBanUser).toHaveBeenCalledWith("streamer", LIVE_CHAT_ID, CHANNEL_ID, {
                type: "temporary",
                durationSecs: MIN_TIMEOUT_SECONDS
            });
        });

        it("clamps durations above the 86399s maximum", async () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);
            await moderation.timeoutUser(CHANNEL_ID, 999999);

            expect(mockBanUser).toHaveBeenCalledWith("streamer", LIVE_CHAT_ID, CHANNEL_ID, {
                type: "temporary",
                durationSecs: MAX_TIMEOUT_SECONDS
            });
        });

        it("skips when not live", async () => {
            const result = await moderation.timeoutUser(CHANNEL_ID, 300);

            expect(result.success).toBe(false);
            expect(mockBanUser).not.toHaveBeenCalled();
        });

        it("rejects a missing channel id", async () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);
            const result = await moderation.timeoutUser(null, 300);

            expect(result.success).toBe(false);
            expect(mockBanUser).not.toHaveBeenCalled();
        });
    });

    describe("banUser", () => {
        it("permanently bans a user with the streamer token", async () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);
            const result = await moderation.banUser(CHANNEL_ID);

            expect(result.success).toBe(true);
            expect(mockBanUser).toHaveBeenCalledWith("streamer", LIVE_CHAT_ID, CHANNEL_ID, {
                type: "permanent"
            });
        });

        it("skips when not live", async () => {
            const result = await moderation.banUser(CHANNEL_ID);

            expect(result.success).toBe(false);
            expect(mockBanUser).not.toHaveBeenCalled();
        });
    });

    describe("unbanUser", () => {
        it("lifts a ban with the streamer token", async () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);
            const result = await moderation.unbanUser(CHANNEL_ID);

            expect(result.success).toBe(true);
            expect(mockUnbanUser).toHaveBeenCalledWith("streamer", CHANNEL_ID);
        });

        it("uses the ban-resource id captured at ban time to lift the ban", async () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);
            mockBanUser.mockResolvedValue("banResourceId123");
            await moderation.banUser(CHANNEL_ID);

            const result = await moderation.unbanUser(CHANNEL_ID);

            expect(result.success).toBe(true);
            expect(mockUnbanUser).toHaveBeenCalledWith("streamer", "banResourceId123");
        });

        it("falls back to the channel id when no ban-resource id is cached", async () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);
            mockBanUser.mockResolvedValue("banResourceId123");
            await moderation.banUser(CHANNEL_ID);
            // A new broadcast clears the cached ban ids.
            youtubeChatEvents.emit("stream-offline");
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);

            const result = await moderation.unbanUser(CHANNEL_ID);

            expect(result.success).toBe(true);
            expect(mockUnbanUser).toHaveBeenCalledWith("streamer", CHANNEL_ID);
        });

        it("skips when not live", async () => {
            const result = await moderation.unbanUser(CHANNEL_ID);

            expect(result.success).toBe(false);
            expect(mockUnbanUser).not.toHaveBeenCalled();
        });
    });

    describe("frontend handler registration (single owner)", () => {
        it("registers the four youtube moderation channels on the singleton", () => {
            const registered = mockOnAsync.mock.calls.map(call => call[0]);
            expect(registered).toEqual(expect.arrayContaining([
                "youtube:delete-message",
                "youtube:timeout-user",
                "youtube:ban-user",
                "youtube:unban-user"
            ]));
        });

        it("applies the default 300s timeout when the frontend omits seconds", async () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);
            const handler = mockOnAsync.mock.calls.find(call => call[0] === "youtube:timeout-user")?.[1];
            await handler({ channelId: CHANNEL_ID });

            expect(mockBanUser).toHaveBeenCalledWith("streamer", LIVE_CHAT_ID, CHANNEL_ID, {
                type: "temporary",
                durationSecs: DEFAULT_TIMEOUT_SECONDS
            });
        });
    });
});

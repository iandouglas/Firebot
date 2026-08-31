/**
 * WS-8: YouTube stream-control unit tests — video-id tracking and title updates
 * (live vs not-live). All collaborators are mocked; no network.
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
        updateBroadcastTitle: jest.fn()
    }
}));

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

import { YouTubeApiError, youtubeChatEvents } from "../contracts";
import { YouTubeStreamControl, youTubeStreamControl } from "../stream-control";
import { youTubeApiClient } from "../youtube-api-client";

const mockUpdateBroadcastTitle = (youTubeApiClient.updateBroadcastTitle as unknown) as jest.Mock;

const VIDEO_ID = "fakeVideoIdBroadcast1";
const LIVE_CHAT_ID = "Cg0KC0Zha2VDaGF0SWT4AyAB";
const TITLE = "My New Stream Title";

let streamControl: YouTubeStreamControl;

beforeEach(() => {
    mockUpdateBroadcastTitle.mockResolvedValue({ id: VIDEO_ID, title: TITLE });
    streamControl = new YouTubeStreamControl();
});

describe("YouTube stream control", () => {
    describe("video id tracking", () => {
        it("is not live until a stream-online event provides a video id", () => {
            expect(streamControl.isLive()).toBe(false);
            expect(streamControl.getVideoId()).toBeNull();
        });

        it("caches the video id from the stream-online event", () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);
            expect(streamControl.isLive()).toBe(true);
            expect(streamControl.getVideoId()).toBe(VIDEO_ID);
        });

        it("clears the video id on stream-offline", () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);
            youtubeChatEvents.emit("stream-offline");
            expect(streamControl.isLive()).toBe(false);
            expect(streamControl.getVideoId()).toBeNull();
        });
    });

    describe("updateTitle", () => {
        it("updates the broadcast title with the streamer token while live", async () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);
            const result = await streamControl.updateTitle(TITLE);

            expect(result.success).toBe(true);
            expect(mockUpdateBroadcastTitle).toHaveBeenCalledWith("streamer", VIDEO_ID, TITLE);
        });

        it("no-ops with a warning when not live", async () => {
            const result = await streamControl.updateTitle(TITLE);

            expect(result.success).toBe(false);
            expect(result.error).toContain("not live");
            expect(mockUpdateBroadcastTitle).not.toHaveBeenCalled();
        });

        it("rejects a missing title", async () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);
            const result = await streamControl.updateTitle(null);

            expect(result.success).toBe(false);
            expect(mockUpdateBroadcastTitle).not.toHaveBeenCalled();
        });

        it("returns an error result (never throws) on a YouTubeApiError", async () => {
            youtubeChatEvents.emit("stream-online", VIDEO_ID, LIVE_CHAT_ID);
            mockUpdateBroadcastTitle.mockRejectedValue(
                new YouTubeApiError("not-found", "video not found", { account: "streamer" })
            );
            const result = await streamControl.updateTitle(TITLE);

            expect(result.success).toBe(false);
            expect(result.error).toContain("not-found");
        });
    });
});

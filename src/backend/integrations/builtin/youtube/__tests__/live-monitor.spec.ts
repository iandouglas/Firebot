/**
 * WS-2 live monitor: poll → live/offline transitions, chat-ingest lifecycle
 * wiring, stream-info-update passthrough and error robustness. All
 * collaborators are mocked; no network, no real timers (jest fake timers).
 */

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

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

jest.mock("../../../../logger-cache", () => ({
    LoggerCache: {
        getLogger: () => mockLogger
    }
}));

jest.mock("../../../../events/event-manager", () => ({
    __esModule: true,
    EventManager: {
        triggerEvent: jest.fn()
    }
}));

jest.mock("../youtube-api-client", () => ({
    __esModule: true,
    youTubeApiClient: {
        listOwnBroadcasts: jest.fn(),
        getVideoLiveDetails: jest.fn()
    }
}));

jest.mock("../chat-ingest", () => ({
    __esModule: true,
    startChatIngest: jest.fn(),
    stopChatIngest: jest.fn()
}));

import frontendCommunicator from "../../../../common/frontend-communicator";
import { EventManager } from "../../../../events/event-manager";

import { youtubeAccountStore } from "../account-store";
import { startChatIngest, stopChatIngest } from "../chat-ingest";
import { YouTubeApiError, youtubeChatEvents, type YouTubeBroadcast, type YouTubeVideoLiveDetails } from "../contracts";
import { youtubeLiveMonitor } from "../live-monitor";
import { youTubeApiClient } from "../youtube-api-client";
import { fakeAuthDetails } from "../testing/google-api-fixtures";

const mockedFrontendSend = (frontendCommunicator.send as unknown) as jest.Mock;
const mockedTriggerEvent = (EventManager.triggerEvent as unknown) as jest.Mock;
const mockedListOwnBroadcasts = (youTubeApiClient.listOwnBroadcasts as unknown) as jest.Mock;
const mockedGetVideoLiveDetails = (youTubeApiClient.getVideoLiveDetails as unknown) as jest.Mock;
const mockedStartChatIngest = startChatIngest as unknown as jest.Mock;
const mockedStopChatIngest = stopChatIngest as unknown as jest.Mock;

const STREAMER_CHANNEL = {
    channelId: "UCfakeStreamerChannelId123",
    channelTitle: "Fake Firebot Streamer",
    avatarUrl: "https://example.test/streamer-avatar-800.jpg"
};

function broadcast(overrides: Partial<YouTubeBroadcast> & { id: string }): YouTubeBroadcast {
    return {
        title: "My Fake Stream",
        liveChatId: `chat-for-${overrides.id}`,
        lifeCycleStatus: "live",
        actualStartTime: "2025-10-01T18:05:00Z",
        ...overrides
    };
}

function details(overrides: Partial<YouTubeVideoLiveDetails> & { videoId: string }): YouTubeVideoLiveDetails {
    return {
        liveChatId: `chat-details-for-${overrides.videoId}`,
        concurrentViewers: "1337",
        totalViewCount: "5678",
        actualStartTime: "2025-10-01T18:05:00Z",
        ...overrides
    };
}

/** Runs one poll tick per `intervalMs` step (start()'s immediate tick is tick #1 at t=0). */
async function runTicks(ticks: number, intervalMs = 60_000): Promise<void> {
    for (let index = 0; index < ticks; index += 1) {
        await jest.advanceTimersByTimeAsync(intervalMs);
    }
}

/** Flushes the immediate tick started by start() (advances the clock by 0ms). */
async function flushInitialTick(): Promise<void> {
    await jest.advanceTimersByTimeAsync(0);
}

describe("live monitor", () => {
    const onlineSpy = jest.fn();
    const offlineSpy = jest.fn();

    beforeEach(() => {
        jest.useFakeTimers();
        mockedListOwnBroadcasts.mockReset();
        mockedGetVideoLiveDetails.mockReset();
        mockedFrontendSend.mockReset();
        mockedTriggerEvent.mockReset();
        mockedStartChatIngest.mockReset();
        mockedStopChatIngest.mockReset();
        mockLogger.debug.mockReset();
        mockLogger.info.mockReset();
        mockLogger.warn.mockReset();
        mockLogger.error.mockReset();

        youtubeAccountStore.setAuth("streamer", fakeAuthDetails("streamer"));
        youtubeAccountStore.setChannel("streamer", STREAMER_CHANNEL);

        onlineSpy.mockReset();
        offlineSpy.mockReset();
        youtubeChatEvents.on("stream-online", onlineSpy);
        youtubeChatEvents.on("stream-offline", offlineSpy);
    });

    afterEach(() => {
        youtubeLiveMonitor.stop();
        youtubeChatEvents.removeListener("stream-online", onlineSpy);
        youtubeChatEvents.removeListener("stream-offline", offlineSpy);
        youtubeAccountStore.clearAll();
        jest.useRealTimers();
    });

    describe("poll transitions", () => {
        it("not-live → live fires stream-online ONCE with correct ids on both buses + starts ingest", async () => {
            mockedListOwnBroadcasts.mockResolvedValue([broadcast({ id: "video-1" })]);
            mockedGetVideoLiveDetails.mockResolvedValue(details({ videoId: "video-1" }));

            youtubeLiveMonitor.start();
            await flushInitialTick();

            expect(mockedListOwnBroadcasts).toHaveBeenCalledTimes(1);
            expect(mockedListOwnBroadcasts).toHaveBeenCalledWith("streamer");
            expect(mockedGetVideoLiveDetails).toHaveBeenCalledWith("streamer", "video-1");

            // youtubeChatEvents contract: (videoId, liveChatId, concurrentViewers?, startedAt?)
            expect(onlineSpy).toHaveBeenCalledTimes(1);
            expect(onlineSpy).toHaveBeenCalledWith("video-1", "chat-for-video-1", 1337, "2025-10-01T18:05:00Z");
            expect(mockedTriggerEvent).toHaveBeenCalledWith("youtube", "stream-online", expect.objectContaining({
                username: STREAMER_CHANNEL.channelTitle,
                userId: STREAMER_CHANNEL.channelId,
                videoId: "video-1",
                liveChatId: "chat-for-video-1"
            }));

            // WS-4 stub wired directly on the transition
            expect(mockedStartChatIngest).toHaveBeenCalledTimes(1);
            expect(mockedStartChatIngest).toHaveBeenCalledWith("chat-for-video-1", "video-1");

            // staying live across further ticks does NOT re-fire the transition
            await runTicks(2);
            expect(onlineSpy).toHaveBeenCalledTimes(1);
            expect(mockedStartChatIngest).toHaveBeenCalledTimes(1);
        });

        it("sends youtube:stream-info-update with parsed viewer count on the online tick", async () => {
            mockedListOwnBroadcasts.mockResolvedValue([broadcast({ id: "video-1" })]);
            mockedGetVideoLiveDetails.mockResolvedValue(details({ videoId: "video-1" }));

            youtubeLiveMonitor.start();
            await flushInitialTick();

            expect(mockedFrontendSend).toHaveBeenCalledWith("youtube:stream-info-update", {
                connected: true,
                live: true,
                preLive: false,
                videoId: "video-1",
                title: "My Fake Stream",
                liveChatId: "chat-for-video-1",
                concurrentViewers: 1337,
                totalViewCount: 5678,
                startedAt: "2025-10-01T18:05:00Z"
            });
        });

        it("live → complete fires stream-offline on both buses and stops the chat reader", async () => {
            mockedListOwnBroadcasts.mockResolvedValueOnce([broadcast({ id: "video-1" })])
                .mockResolvedValue([broadcast({ id: "video-1", lifeCycleStatus: "complete" })]);
            mockedGetVideoLiveDetails.mockResolvedValue(details({ videoId: "video-1" }));

            youtubeLiveMonitor.start();
            await flushInitialTick();
            await runTicks(1);

            expect(offlineSpy).toHaveBeenCalledTimes(1);
            expect(mockedTriggerEvent).toHaveBeenCalledWith("youtube", "stream-offline", {
                username: STREAMER_CHANNEL.channelTitle,
                userId: STREAMER_CHANNEL.channelId,
                userDisplayName: STREAMER_CHANNEL.channelTitle
            });
            expect(mockedStopChatIngest).toHaveBeenCalledTimes(1);

            // offline state reaches the dashboard
            expect(mockedFrontendSend).toHaveBeenCalledWith("youtube:stream-info-update", expect.objectContaining({
                connected: true,
                live: false,
                videoId: null
            }));

            // subsequent offline ticks do not re-fire
            await runTicks(2);
            expect(offlineSpy).toHaveBeenCalledTimes(1);
            expect(mockedStopChatIngest).toHaveBeenCalledTimes(1);
        });

        it("testStarting is pre-live: no transition, no chat start, dashboard sees preLive", async () => {
            mockedListOwnBroadcasts.mockResolvedValue([broadcast({ id: "video-1", lifeCycleStatus: "testStarting" })]);

            youtubeLiveMonitor.start();
            await runTicks(3);

            expect(onlineSpy).not.toHaveBeenCalled();
            expect(offlineSpy).not.toHaveBeenCalled();
            expect(mockedStartChatIngest).not.toHaveBeenCalled();
            expect(mockedStopChatIngest).not.toHaveBeenCalled();
            expect(mockedGetVideoLiveDetails).not.toHaveBeenCalled();
            expect(mockedFrontendSend).toHaveBeenCalledWith("youtube:stream-info-update", expect.objectContaining({
                connected: true,
                live: false,
                preLive: true
            }));
        });

        it("multiple live broadcasts → picks the most recently started (actualStartTime)", async () => {
            mockedListOwnBroadcasts.mockResolvedValue([
                broadcast({ id: "older-video", actualStartTime: "2025-10-01T12:00:00Z" }),
                broadcast({ id: "newer-video", actualStartTime: "2025-10-01T18:05:00Z" })
            ]);
            mockedGetVideoLiveDetails.mockResolvedValue(details({ videoId: "newer-video" }));

            youtubeLiveMonitor.start();
            await flushInitialTick();

            expect(onlineSpy).toHaveBeenCalledWith("newer-video", expect.anything(), expect.anything(), expect.anything());
            expect(mockedGetVideoLiveDetails).toHaveBeenCalledWith("streamer", "newer-video");
            expect(mockedStartChatIngest).toHaveBeenCalledWith("chat-for-newer-video", "newer-video");
        });

        it("falls back to scheduledStartTime when actualStartTime is missing", async () => {
            mockedListOwnBroadcasts.mockResolvedValue([
                broadcast({ id: "older-video", actualStartTime: undefined, scheduledStartTime: "2025-10-01T17:00:00Z" }),
                broadcast({ id: "newer-video", actualStartTime: undefined, scheduledStartTime: "2025-10-01T19:00:00Z" })
            ]);
            mockedGetVideoLiveDetails.mockResolvedValue(details({ videoId: "newer-video" }));

            youtubeLiveMonitor.start();
            await flushInitialTick();

            expect(mockedGetVideoLiveDetails).toHaveBeenCalledWith("streamer", "newer-video");
        });

        it("liveChatId falls back to details.chatId when the broadcast omits it", async () => {
            mockedListOwnBroadcasts.mockResolvedValue([broadcast({ id: "video-1", liveChatId: undefined })]);
            mockedGetVideoLiveDetails.mockResolvedValue(details({ videoId: "video-1", liveChatId: "chat-from-details" }));

            youtubeLiveMonitor.start();
            await flushInitialTick();

            expect(mockedStartChatIngest).toHaveBeenCalledWith("chat-from-details", "video-1");
            expect(onlineSpy).toHaveBeenCalledWith("video-1", "chat-from-details", 1337, "2025-10-01T18:05:00Z");
        });

        it("viewer count refreshes while live (piggyback details each tick, change → re-send)", async () => {
            mockedListOwnBroadcasts.mockResolvedValue([broadcast({ id: "video-1" })]);
            mockedGetVideoLiveDetails.mockResolvedValue(details({ videoId: "video-1", concurrentViewers: "1337" }));

            youtubeLiveMonitor.start();
            await flushInitialTick();

            mockedGetVideoLiveDetails.mockResolvedValue(details({ videoId: "video-1", concurrentViewers: "2000" }));
            await runTicks(1);

            expect(mockedGetVideoLiveDetails).toHaveBeenCalledTimes(2);
            expect(mockedFrontendSend).toHaveBeenCalledWith("youtube:stream-info-update", expect.objectContaining({
                live: true,
                concurrentViewers: 2000
            }));
        });
    });

    describe("robustness", () => {
        it("3 consecutive 'other' failures back off to 5min, success recovers 60s cadence", async () => {
            const otherError = new YouTubeApiError("other", "GET /liveBroadcasts failed: network error", { reason: "socket hang up" });
            mockedListOwnBroadcasts.mockRejectedValueOnce(otherError)
                .mockRejectedValueOnce(otherError)
                .mockRejectedValueOnce(otherError)
                .mockResolvedValue([broadcast({ id: "video-1" })]);
            mockedGetVideoLiveDetails.mockResolvedValue(details({ videoId: "video-1" }));

            youtubeLiveMonitor.start();

            // ticks 1–3 at 60s cadence, all failing (immediate + 2 more)
            await runTicks(3);
            expect(mockedListOwnBroadcasts).toHaveBeenCalledTimes(3);

            // backoff: a 60s step is NOT enough to reach the next tick
            await runTicks(1);
            expect(mockedListOwnBroadcasts).toHaveBeenCalledTimes(3);

            // ...but the full 5 minutes since the 3rd failure is (t=300,360,420)
            await runTicks(3);
            expect(mockedListOwnBroadcasts).toHaveBeenCalledTimes(4);

            // success recovered the cadence → next tick 60s later
            await runTicks(1);
            expect(mockedListOwnBroadcasts).toHaveBeenCalledTimes(5);

            // transition (warn) + recovery (info) logged
            const warns = mockLogger.warn.mock.calls.map(call => String(call[0])).join("\n");
            expect(warns).toContain("backing off");
            expect(mockLogger.info.mock.calls.map(call => String(call[0])).join("\n")).toContain("recovered");
        });

        it("auth/quota/rate-limit errors never crash the interval and never count toward backoff", async () => {
            mockedListOwnBroadcasts.mockRejectedValueOnce(new YouTubeApiError("auth", "401 invalid credentials", {}))
                .mockRejectedValueOnce(new YouTubeApiError("quota", "403 quotaExceeded", {}))
                .mockRejectedValueOnce(new YouTubeApiError("rate-limit", "403 rateLimitExceeded", {}))
                .mockResolvedValue([broadcast({ id: "video-1" })]);
            mockedGetVideoLiveDetails.mockResolvedValue(details({ videoId: "video-1" }));

            youtubeLiveMonitor.start();

            // 3 failing ticks (immediate + 2), each 60s apart
            await flushInitialTick();
            await runTicks(2);
            expect(mockedListOwnBroadcasts).toHaveBeenCalledTimes(3);

            await runTicks(1); // success arrives 60s after the 3rd failure, not 5min
            expect(mockedListOwnBroadcasts).toHaveBeenCalledTimes(4);

            const warns = mockLogger.warn.mock.calls.map(call => String(call[0])).join("\n");
            expect(warns).toContain("kind=auth");
            expect(warns).toContain("kind=quota");
            expect(warns).toContain("kind=rate-limit");
            expect(warns).not.toContain("backing off");
        });

        it("details failure in the same tick never blocks the online transition", async () => {
            mockedListOwnBroadcasts.mockResolvedValue([broadcast({ id: "video-1" })]);
            mockedGetVideoLiveDetails.mockRejectedValue(new YouTubeApiError("rate-limit", "403 rateLimitExceeded", {}));

            youtubeLiveMonitor.start();
            await flushInitialTick();

            expect(onlineSpy).toHaveBeenCalledTimes(1);
            expect(mockedStartChatIngest).toHaveBeenCalledTimes(1);
            expect(mockedFrontendSend).toHaveBeenCalledWith("youtube:stream-info-update", expect.objectContaining({
                live: true,
                concurrentViewers: null
            }));
        });

        it("a non-YouTubeApiError counts as kind 'other' toward backoff", async () => {
            mockedListOwnBroadcasts.mockRejectedValueOnce(new TypeError("fetch failed"))
                .mockRejectedValueOnce(new TypeError("fetch failed"))
                .mockRejectedValueOnce(new TypeError("fetch failed"))
                .mockResolvedValue([broadcast({ id: "video-1" })]);
            mockedGetVideoLiveDetails.mockResolvedValue(details({ videoId: "video-1" }));

            youtubeLiveMonitor.start();
            await runTicks(3);
            await runTicks(1);
            expect(mockedListOwnBroadcasts).toHaveBeenCalledTimes(3);
            expect(mockLogger.warn.mock.calls.map(call => String(call[0])).join("\n")).toContain("kind=other");
        });
    });

    describe("monitor lifecycle", () => {
        it("start is a no-op with no streamer account stored", async () => {
            youtubeAccountStore.clearAll();

            youtubeLiveMonitor.start();
            await flushInitialTick();

            expect(mockedListOwnBroadcasts).not.toHaveBeenCalled();
            expect(youtubeLiveMonitor.isRunning()).toBe(false);
        });

        it("start is idempotent (no double interval)", async () => {
            mockedListOwnBroadcasts.mockResolvedValue([]);

            youtubeLiveMonitor.start();
            youtubeLiveMonitor.start();
            await runTicks(1);

            expect(mockedListOwnBroadcasts).toHaveBeenCalledTimes(2); // immediate tick + one 60s tick
        });

        it("stop() ends ticking and clears cached live state", async () => {
            mockedListOwnBroadcasts.mockResolvedValue([broadcast({ id: "video-1" })]);
            mockedGetVideoLiveDetails.mockResolvedValue(details({ videoId: "video-1" }));

            youtubeLiveMonitor.start();
            await flushInitialTick();
            expect(youtubeLiveMonitor.getCurrentLive()?.videoId).toBe("video-1");

            youtubeLiveMonitor.stop();
            await runTicks(3);

            expect(mockedListOwnBroadcasts).toHaveBeenCalledTimes(1);
            expect(youtubeLiveMonitor.getCurrentLive()).toBeNull();
            expect(youtubeLiveMonitor.isRunning()).toBe(false);
        });

        it("stop() after a session that sent updates emits one final connected:false send", async () => {
            mockedListOwnBroadcasts.mockResolvedValue([broadcast({ id: "video-1" })]);
            mockedGetVideoLiveDetails.mockResolvedValue(details({ videoId: "video-1" }));

            youtubeLiveMonitor.start();
            await flushInitialTick();

            mockedFrontendSend.mockReset();
            youtubeLiveMonitor.stop();

            expect(mockedFrontendSend).toHaveBeenCalledTimes(1);
            expect(mockedFrontendSend).toHaveBeenCalledWith("youtube:stream-info-update", expect.objectContaining({
                connected: false,
                live: false,
                videoId: null
            }));
        });

        it("re-live after offline fires stream-online again (complete → new broadcast)", async () => {
            mockedListOwnBroadcasts.mockResolvedValueOnce([broadcast({ id: "video-1" })])
                .mockResolvedValueOnce([broadcast({ id: "video-1", lifeCycleStatus: "complete" })])
                .mockResolvedValue([broadcast({ id: "video-2" })]);
            mockedGetVideoLiveDetails.mockResolvedValue(details({ videoId: "video-2" }));

            youtubeLiveMonitor.start();
            await runTicks(3);

            expect(onlineSpy).toHaveBeenCalledTimes(2);
            expect(mockedStopChatIngest).toHaveBeenCalledTimes(1);
            expect(mockedStartChatIngest).toHaveBeenLastCalledWith("chat-for-video-2", "video-2");
        });

        it("a different broadcast replacing the live one transitions offline then online", async () => {
            mockedListOwnBroadcasts.mockResolvedValueOnce([broadcast({ id: "video-1" })])
                .mockResolvedValue([broadcast({ id: "video-2", actualStartTime: "2025-10-01T19:00:00Z" })]);
            mockedGetVideoLiveDetails.mockResolvedValue(details({ videoId: "video-2" }));

            youtubeLiveMonitor.start();
            await runTicks(2);

            expect(offlineSpy).toHaveBeenCalledTimes(1);
            expect(onlineSpy).toHaveBeenCalledTimes(2);
        });
    });
});
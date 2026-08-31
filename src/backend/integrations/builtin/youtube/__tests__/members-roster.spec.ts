/**
 * WS-9 members roster: happy path (levels + mixed members), graceful 403 →
 * unavailable + single warn + no retry spam, 15-min cadence while live, viewer
 * upsert call-through, frontend payload shape, and the subscribe hook. All
 * collaborators are mocked; no network, no electron (jest fake timers).
 */

jest.mock("../../../../common/frontend-communicator", () => ({
    __esModule: true,
    default: {
        on: jest.fn(),
        onAsync: jest.fn(),
        send: jest.fn()
    }
}));

jest.mock("../../../../logger-cache", () => ({
    LoggerCache: { getLogger: () => mockLogger }
}));

jest.mock("../../../../viewers/viewer-database", () => ({
    __esModule: true,
    default: {
        isViewerDBOn: jest.fn(() => true),
        upsertYouTubeViewer: jest.fn()
    }
}));

jest.mock("../youtube-api-client", () => ({
    __esModule: true,
    youTubeApiClient: {
        listMembers: jest.fn(),
        listMembershipLevels: jest.fn()
    }
}));

jest.mock("../account-store", () => ({
    __esModule: true,
    youtubeAccountStore: {
        getRawAccount: jest.fn(() => ({
            providerId: "youtube:streamer-account",
            auth: { access_token: "fake" },
            channel: null
        }))
    }
}));

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

import frontendCommunicator from "../../../../common/frontend-communicator";
import viewerDatabase from "../../../../viewers/viewer-database";
import { youtubeAccountStore } from "../account-store";
import { YouTubeApiError, youtubeChatEvents, type YouTubeMembershipLevel } from "../contracts";
import { YouTubeMembersRoster, type YouTubeRosterMember } from "../members-roster";
import { youTubeApiClient } from "../youtube-api-client";

const mockFrontendSend = (frontendCommunicator.send as unknown) as jest.Mock;
const mockListMembers = (youTubeApiClient.listMembers as unknown) as jest.Mock;
const mockListMembershipLevels = (youTubeApiClient.listMembershipLevels as unknown) as jest.Mock;
const mockUpsertYouTubeViewer = (viewerDatabase.upsertYouTubeViewer as unknown) as jest.Mock;
const mockGetRawAccount = (youtubeAccountStore.getRawAccount as unknown) as jest.Mock;

const REFRESH_MS = 15 * 60 * 1000;

const levels: YouTubeMembershipLevel[] = [
    { id: "level1", level: 1, displayName: "Member" },
    { id: "level2", level: 2, displayName: "Gold Member" }
];

const members = [
    {
        channelId: "UCmemberOne",
        displayName: "Member One",
        avatarUrl: "https://example.test/m1.jpg",
        highestAccessibleLevel: "level1",
        highestAccessibleLevelDisplayName: "Member (1 year)"
    },
    {
        channelId: "UCmemberTwo",
        displayName: "Member Two",
        avatarUrl: "https://example.test/m2.jpg",
        highestAccessibleLevel: "level2",
        highestAccessibleLevelDisplayName: undefined
    }
];

const expectedRoster: YouTubeRosterMember[] = [
    { channelId: "UCmemberOne", displayName: "Member One", levelName: "Member (1 year)" },
    { channelId: "UCmemberTwo", displayName: "Member Two", levelName: "Gold Member" }
];

function makeRoster(): YouTubeMembersRoster {
    return new YouTubeMembersRoster({ refreshIntervalMs: REFRESH_MS });
}

/** Flushes the immediate fetch started by start() (advances the clock by 0ms). */
async function flushInitialFetch(): Promise<void> {
    await jest.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
    jest.useFakeTimers();
    // Clear listeners added by previous roster instances on the shared emitter.
    youtubeChatEvents.removeAllListeners();
    mockFrontendSend.mockClear();
    mockListMembers.mockReset();
    mockListMembershipLevels.mockReset();
    mockUpsertYouTubeViewer.mockReset();
    mockUpsertYouTubeViewer.mockResolvedValue({ _id: "youtube:UCmemberOne" });
    mockGetRawAccount.mockReturnValue({
        providerId: "youtube:streamer-account",
        auth: { access_token: "fake" },
        channel: null
    });
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
});

afterEach(() => {
    jest.useRealTimers();
});

describe("YouTube members roster", () => {
    describe("happy path", () => {
        it("caches the roster with level names, marks available, pushes the payload and upserts viewers", async () => {
            mockListMembers.mockResolvedValue({ members, nextPageToken: undefined });
            mockListMembershipLevels.mockResolvedValue(levels);

            const roster = makeRoster();
            roster.start();
            await flushInitialFetch();

            expect(roster.isAvailable()).toBe(true);
            expect(roster.getRoster()).toEqual(expectedRoster);
            expect(roster.getLevels()).toEqual(levels);

            // Frontend payload shape mirrors youtube:bot-auth-update.
            expect(mockFrontendSend).toHaveBeenCalledWith("youtube:members-updated", {
                available: true,
                members: expectedRoster
            });

            // Viewer upsert call-through for every member.
            expect(mockUpsertYouTubeViewer).toHaveBeenCalledTimes(2);
            expect(mockUpsertYouTubeViewer).toHaveBeenCalledWith("UCmemberOne", { displayName: "Member One" });
            expect(mockUpsertYouTubeViewer).toHaveBeenCalledWith("UCmemberTwo", { displayName: "Member Two" });
        });

        it("does not push a duplicate payload when nothing changed", async () => {
            mockListMembers.mockResolvedValue({ members, nextPageToken: undefined });
            mockListMembershipLevels.mockResolvedValue(levels);

            const roster = makeRoster();
            roster.start();
            await flushInitialFetch();

            // Force a second fetch (stream live + one refresh tick) with the same data.
            youtubeChatEvents.emit("stream-online");
            await jest.advanceTimersByTimeAsync(REFRESH_MS);

            expect(mockFrontendSend).toHaveBeenCalledTimes(1);
        });
    });

    describe("graceful degradation", () => {
        it("403 member-data gating → unavailable, warns once, retries only on the next scheduled tick", async () => {
            mockListMembers.mockRejectedValue(
                new YouTubeApiError("other", "members.list failed: Access forbidden.", { httpStatus: 403, reason: "forbidden" })
            );
            mockListMembershipLevels.mockRejectedValue(
                new YouTubeApiError("other", "membershipsLevels.list failed: Access forbidden.", { httpStatus: 403, reason: "forbidden" })
            );

            const roster = makeRoster();
            roster.start();
            await flushInitialFetch();

            expect(roster.isAvailable()).toBe(false);
            expect(roster.getRoster()).toEqual([]);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn.mock.calls[0][0]).toContain("members API unavailable");

            // No retry spam while offline: advancing the clock does not re-fetch.
            await jest.advanceTimersByTimeAsync(REFRESH_MS);
            expect(mockListMembers).toHaveBeenCalledTimes(1);

            // Stream goes live → the next scheduled tick retries exactly once.
            youtubeChatEvents.emit("stream-online");
            await jest.advanceTimersByTimeAsync(REFRESH_MS);
            expect(mockListMembers).toHaveBeenCalledTimes(2);

            // Still only one warning across all failures.
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        });

        it("quota error → unavailable with a single warn", async () => {
            mockListMembers.mockRejectedValue(
                new YouTubeApiError("quota", "members.list failed: quota exceeded.", { httpStatus: 403, reason: "quotaExceeded" })
            );
            mockListMembershipLevels.mockRejectedValue(
                new YouTubeApiError("quota", "membershipsLevels.list failed: quota exceeded.", { httpStatus: 403, reason: "quotaExceeded" })
            );

            const roster = makeRoster();
            roster.start();
            await flushInitialFetch();

            expect(roster.isAvailable()).toBe(false);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        });

        it("recovers to available after a later success and re-arms the warning", async () => {
            mockListMembers.mockRejectedValueOnce(
                new YouTubeApiError("other", "members.list failed: Access forbidden.", { httpStatus: 403, reason: "forbidden" })
            );
            mockListMembershipLevels.mockRejectedValueOnce(
                new YouTubeApiError("other", "membershipsLevels.list failed: Access forbidden.", { httpStatus: 403, reason: "forbidden" })
            );
            mockListMembers.mockResolvedValue({ members, nextPageToken: undefined });
            mockListMembershipLevels.mockResolvedValue(levels);

            const roster = makeRoster();
            roster.start();
            await flushInitialFetch();
            expect(roster.isAvailable()).toBe(false);

            // Next scheduled tick (live) succeeds → available again.
            youtubeChatEvents.emit("stream-online");
            await jest.advanceTimersByTimeAsync(REFRESH_MS);
            expect(roster.isAvailable()).toBe(true);
            expect(roster.getRoster()).toEqual(expectedRoster);
        });

        it("transient rate-limit keeps last availability and does not warn as unavailable", async () => {
            mockListMembers.mockRejectedValue(
                new YouTubeApiError("rate-limit", "members.list failed: rate limited.", { httpStatus: 403, reason: "rateLimitExceeded" })
            );
            mockListMembershipLevels.mockRejectedValue(
                new YouTubeApiError("rate-limit", "membershipsLevels.list failed: rate limited.", { httpStatus: 403, reason: "rateLimitExceeded" })
            );

            const roster = makeRoster();
            roster.start();
            await flushInitialFetch();

            // rate-limit is transient: availability stays false (never fetched) but
            // the "unavailable" warning is NOT emitted.
            expect(roster.isAvailable()).toBe(false);
            expect(mockLogger.warn.mock.calls.some(call => String(call[0]).includes("members API unavailable"))).toBe(false);
        });
    });

    describe("15-min cadence", () => {
        it("refreshes every 15 min while live and pauses while offline", async () => {
            mockListMembers.mockResolvedValue({ members, nextPageToken: undefined });
            mockListMembershipLevels.mockResolvedValue(levels);

            const roster = makeRoster();
            roster.start();
            await flushInitialFetch();
            expect(mockListMembers).toHaveBeenCalledTimes(1);

            // Offline: no refresh on the tick.
            await jest.advanceTimersByTimeAsync(REFRESH_MS);
            expect(mockListMembers).toHaveBeenCalledTimes(1);

            // Live: refresh on each tick.
            youtubeChatEvents.emit("stream-online");
            await jest.advanceTimersByTimeAsync(REFRESH_MS);
            expect(mockListMembers).toHaveBeenCalledTimes(2);
            await jest.advanceTimersByTimeAsync(REFRESH_MS);
            expect(mockListMembers).toHaveBeenCalledTimes(3);

            // Offline again: pauses.
            youtubeChatEvents.emit("stream-offline");
            await jest.advanceTimersByTimeAsync(REFRESH_MS);
            expect(mockListMembers).toHaveBeenCalledTimes(3);
        });
    });

    describe("lifecycle", () => {
        it("start() is a no-op without a linked streamer account", async () => {
            mockGetRawAccount.mockReturnValue(null);

            const roster = makeRoster();
            roster.start();
            await flushInitialFetch();

            expect(roster.isRunning()).toBe(false);
            expect(mockListMembers).not.toHaveBeenCalled();
        });

        it("stop() clears the timer and stops refreshing", async () => {
            mockListMembers.mockResolvedValue({ members, nextPageToken: undefined });
            mockListMembershipLevels.mockResolvedValue(levels);

            const roster = makeRoster();
            roster.start();
            await flushInitialFetch();
            expect(roster.isRunning()).toBe(true);

            roster.stop();
            expect(roster.isRunning()).toBe(false);

            youtubeChatEvents.emit("stream-online");
            await jest.advanceTimersByTimeAsync(REFRESH_MS);
            expect(mockListMembers).toHaveBeenCalledTimes(1);
        });
    });

    describe("subscribe hook", () => {
        it("notifies subscribers on roster change and returns an unsubscribe", async () => {
            mockListMembers.mockResolvedValue({ members, nextPageToken: undefined });
            mockListMembershipLevels.mockResolvedValue(levels);

            const roster = makeRoster();
            const callback = jest.fn();
            const unsubscribe = roster.subscribe(callback);

            roster.start();
            await flushInitialFetch();

            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith({ available: true, members: expectedRoster });

            unsubscribe();
            youtubeChatEvents.emit("stream-online");
            await jest.advanceTimersByTimeAsync(REFRESH_MS);
            expect(callback).toHaveBeenCalledTimes(1);
        });
    });
});

/**
 * WS-5: YouTube chat sender unit tests — live-chat-id tracking, chatter
 * resolution, truncation, serialization and the daily quota guard.
 * All collaborators are mocked; no network, no electron, no fake timers needed
 * (the serialization gap is injectable).
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
        insertChatMessage: jest.fn()
    }
}));

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

import frontendCommunicator from "../../../../common/frontend-communicator";
import { youtubeAccountStore } from "../account-store";
import { YouTubeApiError, youtubeChatEvents } from "../contracts";
import {
    DEFAULT_DAILY_SEND_BUDGET,
    MAX_YOUTUBE_CHAT_LENGTH,
    YouTubeChatSender,
    youTubeChatSender
} from "../chat-sender";
import { youTubeApiClient } from "../youtube-api-client";
import { channelsListFixture, fakeAuthDetails } from "../testing/google-api-fixtures";
import type { YouTubeChannelInfo } from "../contracts";

const mockInsertChatMessage = (youTubeApiClient.insertChatMessage as unknown) as jest.Mock;
const mockFrontendSend = (frontendCommunicator.send as unknown) as jest.Mock;

const streamerChannel: YouTubeChannelInfo = {
    channelId: channelsListFixture.items[0].id,
    channelTitle: channelsListFixture.items[0].snippet.title,
    avatarUrl: channelsListFixture.items[0].snippet.thumbnails.high.url
};

const botChannel: YouTubeChannelInfo = {
    channelId: "UCfakeBotChannelId456",
    channelTitle: "Fake Firebot Bot",
    avatarUrl: "https://example.test/bot-avatar-88.jpg"
};

const LIVE_CHAT_ID = "Cg0KC0Zha2VDaGF0SWT4AyAB";

let sender: YouTubeChatSender;

function makeSender(overrides: { dailySendBudget?: number; getDayKey?: () => string } = {}): YouTubeChatSender {
    // gap 0 so tests do not sleep; the default-gap serialization timing is
    // covered by its own test.
    return new YouTubeChatSender({ sendGapMs: 0, ...overrides });
}

beforeEach(() => {
    youtubeAccountStore.clearAll();
    mockInsertChatMessage.mockResolvedValue({ id: "fakeInsertedMessageId" });
    sender = makeSender();
});

describe("YouTube chat sender", () => {
    describe("live chat id tracking", () => {
        it("skips sends while no live chat id is known", async () => {
            const result = await sender.sendChatMessage("hello");

            expect(result).toEqual({ success: false, skipped: "not-live" });
            expect(mockInsertChatMessage).not.toHaveBeenCalled();
        });

        it("caches the live chat id from the stream-online event", async () => {
            expect(sender.isLive()).toBe(false);

            youtubeAccountStore.setChannel("bot", botChannel);
            youtubeAccountStore.setAuth("bot", fakeAuthDetails("bot"));

            youtubeChatEvents.emit("stream-online", "fakeVideoId", LIVE_CHAT_ID);

            expect(sender.isLive()).toBe(true);
            expect(sender.getLiveChatId()).toBe(LIVE_CHAT_ID);

            await sender.sendChatMessage("hello");

            expect(mockInsertChatMessage).toHaveBeenCalledWith("bot", LIVE_CHAT_ID, "hello");
        });

        it("tolerates a stream-online event without a live chat id", async () => {
            youtubeChatEvents.emit("stream-online", "fakeVideoId", undefined);
            expect(sender.isLive()).toBe(false);

            youtubeChatEvents.emit("stream-online", "fakeVideoId", "");
            expect(sender.isLive()).toBe(false);
        });

        it("clears the live chat id on stream-offline so sends skip again", async () => {
            youtubeChatEvents.emit("stream-online", "fakeVideoId", LIVE_CHAT_ID);
            youtubeChatEvents.emit("stream-offline");

            const result = await sender.sendChatMessage("hello");

            expect(result).toEqual({ success: false, skipped: "not-live" });
            expect(mockInsertChatMessage).not.toHaveBeenCalled();
        });
    });

    describe("chatter account selection", () => {
        beforeEach(() => {
            youtubeChatEvents.emit("stream-online", "fakeVideoId", LIVE_CHAT_ID);
        });

        it("prefers the bot account by default when it is linked", async () => {
            youtubeAccountStore.setChannel("streamer", streamerChannel);
            youtubeAccountStore.setAuth("streamer", fakeAuthDetails("streamer"));
            youtubeAccountStore.setChannel("bot", botChannel);
            youtubeAccountStore.setAuth("bot", fakeAuthDetails("bot"));

            await sender.sendChatMessage("hi");

            expect(mockInsertChatMessage).toHaveBeenCalledWith("bot", LIVE_CHAT_ID, "hi");
        });

        it("falls back to the streamer account when no bot is linked (default chatter)", async () => {
            youtubeAccountStore.setChannel("streamer", streamerChannel);
            youtubeAccountStore.setAuth("streamer", fakeAuthDetails("streamer"));

            const result = await sender.sendChatMessage("hi");

            expect(result.success).toBe(true);
            expect(mockInsertChatMessage).toHaveBeenCalledWith("streamer", LIVE_CHAT_ID, "hi");
        });

        it("honors an explicit streamer chatter", async () => {
            youtubeAccountStore.setChannel("streamer", streamerChannel);
            youtubeAccountStore.setAuth("streamer", fakeAuthDetails("streamer"));
            youtubeAccountStore.setChannel("bot", botChannel);
            youtubeAccountStore.setAuth("bot", fakeAuthDetails("bot"));

            const result = await sender.sendChatMessage("hi", { accountType: "Streamer" });

            expect(result.success).toBe(true);
            expect(mockInsertChatMessage).toHaveBeenCalledWith("streamer", LIVE_CHAT_ID, "hi");
        });

        it("falls back to the streamer account when a bot chatter was requested but no bot is linked", async () => {
            youtubeAccountStore.setChannel("streamer", streamerChannel);
            youtubeAccountStore.setAuth("streamer", fakeAuthDetails("streamer"));

            const result = await sender.sendChatMessage("hi", { accountType: "Bot" });

            expect(result.success).toBe(true);
            expect(result.account).toBe("streamer");
            expect(mockInsertChatMessage).toHaveBeenCalledWith("streamer", LIVE_CHAT_ID, "hi");
        });

        it("skips silently when an explicit streamer chatter has no streamer account", async () => {
            youtubeAccountStore.setChannel("bot", botChannel);
            youtubeAccountStore.setAuth("bot", fakeAuthDetails("bot"));

            const result = await sender.sendChatMessage("hi", { accountType: "Streamer" });

            expect(result).toEqual({ success: false, skipped: "missing-account", account: undefined });
            expect(mockInsertChatMessage).not.toHaveBeenCalled();
        });

        it("skips silently when no YouTube account is linked at all", async () => {
            const result = await sender.sendChatMessage("hi");

            expect(result).toEqual({ success: false, skipped: "missing-account" });
            expect(mockInsertChatMessage).not.toHaveBeenCalled();
        });
    });

    describe("length handling", () => {
        beforeEach(() => {
            youtubeAccountStore.setChannel("bot", botChannel);
            youtubeAccountStore.setAuth("bot", fakeAuthDetails("bot"));
            youtubeChatEvents.emit("stream-online", "fakeVideoId", LIVE_CHAT_ID);
        });

        it("leaves messages at or under the 200 char cap untouched", async () => {
            const text = "a".repeat(MAX_YOUTUBE_CHAT_LENGTH);
            await sender.sendChatMessage(text);

            expect(mockInsertChatMessage).toHaveBeenCalledWith("bot", LIVE_CHAT_ID, text);
        });

        it("truncates longer messages to 200 chars including an ellipsis", async () => {
            const text = "b".repeat(600);
            await sender.sendChatMessage(text);

            const insertedText = mockInsertChatMessage.mock.calls[0][2] as string;
            expect(insertedText.length).toBe(MAX_YOUTUBE_CHAT_LENGTH);
            expect(insertedText.endsWith("…")).toBe(true);
            expect(insertedText.startsWith("b")).toBe(true);
        });

        it("ignores whitespace-only messages", async () => {
            const result = await sender.sendChatMessage("   \n\t ");

            expect(result.success).toBe(false);
            expect(mockInsertChatMessage).not.toHaveBeenCalled();
        });

        it("trims surrounding whitespace from the message", async () => {
            await sender.sendChatMessage("  hello there  ");

            expect(mockInsertChatMessage).toHaveBeenCalledWith("bot", LIVE_CHAT_ID, "hello there");
        });
    });

    describe("serialization", () => {
        beforeEach(() => {
            youtubeAccountStore.setChannel("bot", botChannel);
            youtubeAccountStore.setAuth("bot", fakeAuthDetails("bot"));
            youtubeChatEvents.emit("stream-online", "fakeVideoId", LIVE_CHAT_ID);
        });

        it("sends concurrent messages strictly one at a time with the default gap between inserts", async () => {
            const timedSender = new YouTubeChatSender(); // default 250ms gap
            // The inner beforeEach already flipped the outer instance live; the
            // fresh instance needs its own stream-online to cache the live chat id.
            youtubeChatEvents.emit("stream-online", "fakeVideoId", LIVE_CHAT_ID);
            const insertTimes: number[] = [];
            mockInsertChatMessage.mockImplementation(async () => {
                insertTimes.push(Date.now());
                return { id: "fakeInsertedMessageId" };
            });

            await Promise.all([
                timedSender.sendChatMessage("one"),
                timedSender.sendChatMessage("two"),
                timedSender.sendChatMessage("three")
            ]);

            expect(mockInsertChatMessage).toHaveBeenCalledTimes(3);
            expect(mockInsertChatMessage.mock.calls.map(call => call[2])).toEqual(["one", "two", "three"]);
            for (let i = 1; i < insertTimes.length; i++) {
                expect(insertTimes[i] - insertTimes[i - 1]).toBeGreaterThanOrEqual(240);
            }
        });

        it("keeps the send chain alive after a failed insert", async () => {
            mockInsertChatMessage.mockRejectedValueOnce(new YouTubeApiError("quota", "quota exceeded"));
            mockInsertChatMessage.mockResolvedValueOnce({ id: "fakeInsertedMessageId" });
            mockInsertChatMessage.mockResolvedValueOnce({ id: "fakeInsertedMessageId" });

            await Promise.all([
                sender.sendChatMessage("fails"),
                sender.sendChatMessage("works-one"),
                sender.sendChatMessage("works-two")
            ]);

            expect(mockInsertChatMessage).toHaveBeenCalledTimes(3);
        });
    });

    describe("insert failures", () => {
        beforeEach(() => {
            youtubeAccountStore.setChannel("bot", botChannel);
            youtubeAccountStore.setAuth("bot", fakeAuthDetails("bot"));
            youtubeChatEvents.emit("stream-online", "fakeVideoId", LIVE_CHAT_ID);
        });

        it("reports YouTubeApiError kinds without throwing", async () => {
            mockInsertChatMessage.mockRejectedValue(new YouTubeApiError("rate-limit", "rate limited"));

            const result = await sender.sendChatMessage("hello");

            expect(result.success).toBe(false);
            expect(result.error).toContain("rate-limit");
        });

        it("reports unexpected errors without throwing", async () => {
            mockInsertChatMessage.mockRejectedValue(new Error("network down"));

            const result = await sender.sendChatMessage("hello");

            expect(result.success).toBe(false);
            expect(result.error).toContain("network down");
        });
    });

    describe("daily quota guard", () => {
        beforeEach(() => {
            youtubeAccountStore.setChannel("bot", botChannel);
            youtubeAccountStore.setAuth("bot", fakeAuthDetails("bot"));
            youtubeChatEvents.emit("stream-online", "fakeVideoId", LIVE_CHAT_ID);
        });

        it("exposes the 80/day default budget", () => {
            expect(DEFAULT_DAILY_SEND_BUDGET).toBe(80);
            expect(youTubeChatSender.getDailySendBudget()).toBe(80);
        });

        it("blocks sends once the daily budget is spent and never throws", async () => {
            const budgeted = makeSender({ dailySendBudget: 3 });
            youtubeChatEvents.emit("stream-online", "fakeVideoId", LIVE_CHAT_ID);

            for (let i = 0; i < 3; i++) {
                await expect(budgeted.sendChatMessage(`msg ${i}`)).resolves.toMatchObject({ success: true });
            }
            expect(mockInsertChatMessage).toHaveBeenCalledTimes(3);

            const blocked = await budgeted.sendChatMessage("over the line");
            expect(blocked).toMatchObject({ success: false, skipped: "quota-budget-exhausted", account: "bot" });
            expect(mockInsertChatMessage).toHaveBeenCalledTimes(3);
        });

        it("escalates the cap to the frontend exactly once per day", async () => {
            const budgeted = makeSender({ dailySendBudget: 2 });
            youtubeChatEvents.emit("stream-online", "fakeVideoId", LIVE_CHAT_ID);

            await budgeted.sendChatMessage("one");
            await budgeted.sendChatMessage("two");
            await budgeted.sendChatMessage("three (blocked)");
            await budgeted.sendChatMessage("four (also blocked)");

            expect(mockFrontendSend).toHaveBeenCalledTimes(1);
            expect(mockFrontendSend).toHaveBeenCalledWith(
                "error",
                expect.stringContaining("NOT sent")
            );
            expect(mockFrontendSend.mock.calls[0][1]).toContain("three (blocked)");
        });

        it("warns at 50, 75 and 80 sends (the final allowed send) with the default budget", async () => {
            const budgeted = makeSender({ dailySendBudget: DEFAULT_DAILY_SEND_BUDGET });
            youtubeChatEvents.emit("stream-online", "fakeVideoId", LIVE_CHAT_ID);

            for (let i = 1; i <= DEFAULT_DAILY_SEND_BUDGET; i++) {
                await budgeted.sendChatMessage(`msg ${i}`);
            }

            expect(mockInsertChatMessage).toHaveBeenCalledTimes(DEFAULT_DAILY_SEND_BUDGET);
            const warnMessages = mockLogger.warn.mock.calls.map(call => String(call[0]));

            const warnAt50 = warnMessages.filter(msg => msg.includes("50/80"));
            const warnAt75 = warnMessages.filter(msg => msg.includes("75/80"));
            const warnAt80 = warnMessages.filter(msg => msg.includes("80/80") && msg.includes("exhausted"));

            expect(warnAt50).toHaveLength(1);
            expect(warnAt75).toHaveLength(1);
            expect(warnAt80).toHaveLength(1);
        });

        it("does not warn before the warning thresholds", async () => {
            const budgeted = makeSender({ dailySendBudget: DEFAULT_DAILY_SEND_BUDGET });
            youtubeChatEvents.emit("stream-online", "fakeVideoId", LIVE_CHAT_ID);

            for (let i = 1; i <= 49; i++) {
                await budgeted.sendChatMessage(`msg ${i}`);
            }

            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        it("blocks sends after the budget is reduced below the current count", async () => {
            const budgeted = makeSender({ dailySendBudget: 5 });
            youtubeChatEvents.emit("stream-online", "fakeVideoId", LIVE_CHAT_ID);
            await budgeted.sendChatMessage("one");

            budgeted.setDailySendBudget(1);

            const blocked = await budgeted.sendChatMessage("two");
            expect(blocked.skipped).toBe("quota-budget-exhausted");
            expect(mockInsertChatMessage).toHaveBeenCalledTimes(1);
        });

        it("resets the budget when the day rolls over", async () => {
            let dayKey = "2026-03-01";
            const budgeted = makeSender({
                dailySendBudget: 2,
                getDayKey: () => dayKey
            });
            youtubeChatEvents.emit("stream-online", "fakeVideoId", LIVE_CHAT_ID);

            await budgeted.sendChatMessage("one");
            await budgeted.sendChatMessage("two");
            expect(await budgeted.sendChatMessage("blocked")).toMatchObject({ skipped: "quota-budget-exhausted" });
            expect(mockFrontendSend).toHaveBeenCalledTimes(1);

            dayKey = "2026-03-02";
            await expect(budgeted.sendChatMessage("fresh day")).resolves.toMatchObject({ success: true });
            expect(mockInsertChatMessage).toHaveBeenCalledTimes(3);
        });
    });
});
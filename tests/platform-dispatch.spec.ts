/**
 * WS-5: platform-dispatch semantics — destination fan-out, disconnected
 * platform no-ops, never-throw guarantees, chatter normalization and /me
 * stripping for the YouTube side.
 */

jest.mock("../src/backend/logger-cache", () => ({
    LoggerCache: {
        getLogger: () => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        })
    }
}));

jest.mock("../src/backend/common/account-access", () => ({
    AccountAccess: {
        getAccounts: jest.fn()
    }
}));

jest.mock("../src/backend/streaming-platforms/twitch/api", () => ({
    TwitchApi: {
        chat: {
            sendChatMessage: jest.fn()
        }
    }
}));

jest.mock("../src/backend/integrations/builtin/youtube/chat-sender", () => ({
    youTubeChatSender: {
        sendChatMessage: jest.fn()
    }
}));

import { AccountAccess } from "../src/backend/common/account-access";
import { platformDispatch } from "../src/backend/chat/platform-dispatch";
import { youTubeChatSender } from "../src/backend/integrations/builtin/youtube/chat-sender";
import { TwitchApi } from "../src/backend/streaming-platforms/twitch/api";

const mockTwitchSendChatMessage = (TwitchApi.chat.sendChatMessage as unknown) as jest.Mock;
const mockYouTubeSend = (youTubeChatSender.sendChatMessage as unknown) as jest.Mock;
const mockGetAccounts = (AccountAccess.getAccounts as unknown) as jest.Mock;

function twitchSendResponse(overrides: Record<string, unknown> = {}): unknown {
    return {
        success: true,
        isSlashCommand: false,
        messageId: "twitch-msg-1",
        ...overrides
    };
}

function youtubeSendResponse(overrides: Record<string, unknown> = {}): unknown {
    return {
        success: true,
        messageId: "yt-msg-1",
        ...overrides
    };
}

beforeEach(() => {
    mockGetAccounts.mockReturnValue({
        streamer: { userId: "twitch-streamer-id", loggedIn: true },
        bot: { userId: "twitch-bot-id", loggedIn: true }
    });
    mockTwitchSendChatMessage.mockResolvedValue(twitchSendResponse());
    mockYouTubeSend.mockResolvedValue(youtubeSendResponse());
});

describe("platform-dispatch", () => {
    describe("destination semantics", () => {
        it("fans out to both platforms by default (locked decision D7)", async () => {
            const result = await platformDispatch.sendChatMessage("hello");

            expect(mockTwitchSendChatMessage).toHaveBeenCalledTimes(1);
            expect(mockYouTubeSend).toHaveBeenCalledTimes(1);
            expect(result.twitch.attempted).toBe(true);
            expect(result.youtube.attempted).toBe(true);
        });

        it("routes to Twitch only when destination is 'twitch'", async () => {
            await platformDispatch.sendChatMessage("hello", { destination: "twitch" });

            expect(mockTwitchSendChatMessage).toHaveBeenCalledTimes(1);
            expect(mockYouTubeSend).not.toHaveBeenCalled();
        });

        it("routes to YouTube only when destination is 'youtube'", async () => {
            const result = await platformDispatch.sendChatMessage("hello", { destination: "youtube" });

            expect(mockTwitchSendChatMessage).not.toHaveBeenCalled();
            expect(mockYouTubeSend).toHaveBeenCalledTimes(1);
            expect(result.twitch.attempted).toBe(false);
            expect(result.youtube.attempted).toBe(true);
        });

        it("treats unknown destinations as 'both'", async () => {
            await platformDispatch.sendChatMessage("hello", { destination: "bogus" as never });

            expect(mockTwitchSendChatMessage).toHaveBeenCalledTimes(1);
            expect(mockYouTubeSend).toHaveBeenCalledTimes(1);
        });

        it("treats a null destination as 'both'", async () => {
            await platformDispatch.sendChatMessage("hello", { destination: null });

            expect(mockTwitchSendChatMessage).toHaveBeenCalledTimes(1);
            expect(mockYouTubeSend).toHaveBeenCalledTimes(1);
        });
    });

    describe("disconnected platforms", () => {
        it("no-ops the Twitch side with a skip reason when Twitch is not logged in", async () => {
            mockGetAccounts.mockReturnValue({
                streamer: { userId: null, loggedIn: false }
            });

            const result = await platformDispatch.sendChatMessage("hello");

            expect(mockTwitchSendChatMessage).not.toHaveBeenCalled();
            expect(result.twitch).toEqual({
                attempted: false,
                success: false,
                skipped: "platform-not-connected"
            });
            expect(result.youtube.attempted).toBe(true);
        });

        it("still delivers YouTube when Twitch is disconnected and never throws", async () => {
            mockGetAccounts.mockReturnValue({ streamer: { userId: null, loggedIn: false } });

            const result = await platformDispatch.sendChatMessage("hello");

            expect(result.youtube.success).toBe(true);
            expect(result.twitch.skipped).toBe("platform-not-connected");
        });

        it("maps the YouTube not-live skip reason onto the dispatch result", async () => {
            mockYouTubeSend.mockResolvedValue({ success: false, skipped: "not-live" });

            const result = await platformDispatch.sendChatMessage("hello");

            expect(result.youtube).toEqual({
                attempted: false,
                success: false,
                skipped: "not-live"
            });
            expect(result.twitch.attempted).toBe(true);
        });

        it("maps the quota budget skip reason onto the dispatch result", async () => {
            mockYouTubeSend.mockResolvedValue({
                success: false,
                skipped: "quota-budget-exhausted",
                account: "bot"
            });

            const result = await platformDispatch.sendChatMessage("hello");

            expect(result.youtube).toEqual({
                attempted: false,
                success: false,
                skipped: "quota-budget-exhausted"
            });
        });

        it("maps the missing YouTube account skip reason onto the dispatch result", async () => {
            mockYouTubeSend.mockResolvedValue({ success: false, skipped: "missing-account" });

            const result = await platformDispatch.sendChatMessage("hello", { destination: "youtube" });

            expect(result.youtube.skipped).toBe("missing-account");
        });
    });

    describe("empty message handling", () => {
        it("attempts nothing for an empty message", async () => {
            const result = await platformDispatch.sendChatMessage("");

            expect(mockTwitchSendChatMessage).not.toHaveBeenCalled();
            expect(mockYouTubeSend).not.toHaveBeenCalled();
            expect(result.twitch.skipped).toBe("empty-message");
            expect(result.youtube.skipped).toBe("empty-message");
        });

        it("attempts nothing for a whitespace-only message", async () => {
            const result = await platformDispatch.sendChatMessage("   \n ");

            expect(result.twitch.skipped).toBe("empty-message");
            expect(result.youtube.skipped).toBe("empty-message");
        });
    });

    describe("chatter normalization", () => {
        it("sends as the Twitch bot only when an explicit bot chatter is requested", async () => {
            await platformDispatch.sendChatMessage("hello", { accountType: "Bot" });
            expect(mockTwitchSendChatMessage).toHaveBeenLastCalledWith("hello", null, true);

            await platformDispatch.sendChatMessage("hello", { accountType: "BOT" });
            expect(mockTwitchSendChatMessage).toHaveBeenLastCalledWith("hello", null, true);
        });

        it("sends as the streamer for the dashboard's 'Both' chatter (Twitch side)", async () => {
            await platformDispatch.sendChatMessage("hello", { accountType: "Both" });

            expect(mockTwitchSendChatMessage).toHaveBeenCalledWith("hello", null, false);
        });

        it("sends as the streamer for explicit 'Streamer' chatter", async () => {
            await platformDispatch.sendChatMessage("hello", { accountType: "streamer" });

            expect(mockTwitchSendChatMessage).toHaveBeenCalledWith("hello", null, false);
        });

        it("passes the chatter preference through to the YouTube sender untouched", async () => {
            await platformDispatch.sendChatMessage("hello", { accountType: "Both" });
            expect(mockYouTubeSend).toHaveBeenLastCalledWith("hello", { accountType: "Both" });

            await platformDispatch.sendChatMessage("hello", { accountType: "Bot" });
            expect(mockYouTubeSend).toHaveBeenLastCalledWith("hello", { accountType: "Bot" });
        });
    });

    describe("/me handling", () => {
        it("keeps the /me prefix for Twitch and strips it for YouTube", async () => {
            await platformDispatch.sendChatMessage("/me does something", { destination: "both" });

            expect(mockTwitchSendChatMessage).toHaveBeenCalledWith("/me does something", null, false);
            expect(mockYouTubeSend).toHaveBeenCalledWith("does something", { accountType: null });
        });

        it("strips /me case-insensitively for YouTube", async () => {
            await platformDispatch.sendChatMessage("/ME waves", { destination: "youtube" });

            expect(mockYouTubeSend).toHaveBeenCalledWith("waves", { accountType: null });
        });

        it("passes plain messages through unchanged", async () => {
            await platformDispatch.sendChatMessage("just talking", { destination: "both" });

            expect(mockTwitchSendChatMessage).toHaveBeenCalledWith("just talking", null, false);
            expect(mockYouTubeSend).toHaveBeenCalledWith("just talking", { accountType: null });
        });
    });

    describe("reply threading", () => {
        it("passes the reply id to Twitch but never to YouTube", async () => {
            await platformDispatch.sendChatMessage("a reply", {
                replyToMessageId: "twitch-parent-1"
            });

            expect(mockTwitchSendChatMessage).toHaveBeenCalledWith("a reply", "twitch-parent-1", false);
            // YouTube payload options never carry reply ids (no reply support in v1)
            expect(mockYouTubeSend).toHaveBeenCalledWith("a reply", { accountType: null });
        });

        it("normalizes missing reply ids to null for the Twitch call", async () => {
            await platformDispatch.sendChatMessage("hello", { replyToMessageId: undefined });

            expect(mockTwitchSendChatMessage).toHaveBeenCalledWith("hello", null, false);
        });
    });

    describe("never-throw guarantees", () => {
        it("reports Twitch send errors without failing the whole dispatch", async () => {
            mockTwitchSendChatMessage.mockRejectedValue(new Error("twurple exploded"));

            const result = await platformDispatch.sendChatMessage("hello");

            expect(result.twitch).toMatchObject({
                attempted: true,
                success: false,
                error: "twurple exploded"
            });
            expect(result.youtube.success).toBe(true);
        });

        it("reports Twitch drop reasons from the send result", async () => {
            mockTwitchSendChatMessage.mockResolvedValue(twitchSendResponse({
                success: false,
                messageId: undefined,
                error: "msg_rejected"
            }));

            const result = await platformDispatch.sendChatMessage("hello");

            expect(result.twitch).toMatchObject({ attempted: true, success: false, error: "msg_rejected" });
        });

        it("reports YouTube insert errors without failing the Twitch side", async () => {
            mockYouTubeSend.mockResolvedValue({ success: false, error: "quota blown" });

            const result = await platformDispatch.sendChatMessage("hello");

            expect(result.youtube).toMatchObject({ attempted: true, success: false, error: "quota blown" });
            expect(result.twitch.success).toBe(true);
        });

        it("returns slash command results from the Twitch side", async () => {
            mockTwitchSendChatMessage.mockResolvedValue(twitchSendResponse({
                success: true,
                isSlashCommand: true,
                messageId: undefined
            }));

            const result = await platformDispatch.sendChatMessage("/me hi");

            expect(result.twitch).toMatchObject({ success: true, isSlashCommand: true });
        });
    });
});
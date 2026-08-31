/**
 * WS-5: Chat effect routing — destination support (default "both" per D7),
 * whisper stays Twitch-only, /me prefix behavior, pin routing via the Twitch
 * dispatch result and reply passthrough.
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

jest.mock("../src/backend/chat/platform-dispatch", () => ({
    platformDispatch: {
        sendChatMessage: jest.fn()
    }
}));

jest.mock("../src/backend/streaming-platforms/twitch/api", () => ({
    TwitchApi: {
        chat: {
            pinChatMessage: jest.fn()
        },
        users: {
            getUserByName: jest.fn()
        },
        whispers: {
            sendWhisper: jest.fn()
        }
    }
}));

import effect from "../src/backend/effects/builtin/chat";
import { platformDispatch } from "../src/backend/chat/platform-dispatch";
import { TwitchApi } from "../src/backend/streaming-platforms/twitch/api";

const mockDispatchSend = (platformDispatch.sendChatMessage as unknown) as jest.Mock;
const mockSendWhisper = (TwitchApi.whispers.sendWhisper as unknown) as jest.Mock;
const mockGetUserByName = (TwitchApi.users.getUserByName as unknown) as jest.Mock;
const mockPinChatMessage = (TwitchApi.chat.pinChatMessage as unknown) as jest.Mock;

const COMMAND_TRIGGER = {
    type: "command",
    metadata: {
        chatMessage: { id: "parent-message-1" }
    }
};

// Loosened context shape for unit-testing the effect body without the full
// EffectInstance/Trigger runtime bag.
const fire = effect.onTriggerEvent as (context: { effect: unknown; trigger: unknown }) => Promise<boolean>;

type EffectModel = {
    chatter: string;
    message: string;
    me: boolean;
    whisper: string;
    sendAsReply: boolean;
    pin: boolean;
    pinUntilEndOfStream: boolean;
    pinDuration?: string;
    destination?: "both" | "twitch" | "youtube";
};

function makeEffect(overrides: Partial<EffectModel> = {}): EffectModel {
    return {
        chatter: "Bot",
        message: "hello world",
        me: false,
        whisper: "",
        sendAsReply: false,
        pin: false,
        pinUntilEndOfStream: false,
        ...overrides
    } as EffectModel;
}

beforeEach(() => {
    mockDispatchSend.mockResolvedValue({
        twitch: { attempted: true, success: true, isSlashCommand: false, messageId: "twitch-msg-1" },
        youtube: { attempted: true, success: true, messageId: "yt-msg-1" }
    });
});

describe("Chat effect", () => {
    describe("destination routing", () => {
        it("defaults to both platforms (locked decision D7)", async () => {
            const result = await fire({ effect: makeEffect(), trigger: COMMAND_TRIGGER });

            expect(result).toBe(true);
            expect(mockDispatchSend).toHaveBeenCalledTimes(1);
            expect(mockDispatchSend).toHaveBeenCalledWith("hello world", {
                destination: "both",
                accountType: "Bot",
                replyToMessageId: null
            });
        });

        it("honors a twitch-only destination", async () => {
            await fire({ effect: makeEffect({ destination: "twitch" }), trigger: COMMAND_TRIGGER });

            expect(mockDispatchSend).toHaveBeenCalledWith("hello world", {
                destination: "twitch",
                accountType: "Bot",
                replyToMessageId: null
            });
        });

        it("honors a youtube-only destination", async () => {
            await fire({ effect: makeEffect({ destination: "youtube" }), trigger: COMMAND_TRIGGER });

            expect(mockDispatchSend).toHaveBeenCalledWith("hello world", expect.objectContaining({ destination: "youtube" }));
        });

        it("passes the command's chat message id as the reply target when sendAsReply is on", async () => {
            await fire({
                effect: makeEffect({ sendAsReply: true }),
                trigger: COMMAND_TRIGGER
            });

            expect(mockDispatchSend).toHaveBeenCalledWith("hello world",
                expect.objectContaining({ replyToMessageId: "parent-message-1" })
            );
        });

        it("uses the event trigger's chat message id for replies", async () => {
            await fire({
                effect: makeEffect({ sendAsReply: true }),
                trigger: {
                    type: "event",
                    metadata: { eventData: { chatMessage: { id: "event-message-1" } } }
                }
            });

            expect(mockDispatchSend).toHaveBeenCalledWith("hello world",
                expect.objectContaining({ replyToMessageId: "event-message-1" })
            );
        });

        it("preserves a missing chatter as the bot voice (legacy behavior)", async () => {
            const legacy = makeEffect();
            legacy.chatter = undefined;

            await fire({ effect: legacy as unknown as EffectModel, trigger: COMMAND_TRIGGER });

            expect(mockDispatchSend).toHaveBeenCalledWith(
                "hello world",
                expect.objectContaining({ accountType: "Bot" })
            );
        });

        it("passes through an explicit streamer chatter", async () => {
            await fire({ effect: makeEffect({ chatter: "Streamer" }), trigger: COMMAND_TRIGGER });

            expect(mockDispatchSend).toHaveBeenCalledWith(
                "hello world",
                expect.objectContaining({ accountType: "Streamer" })
            );
        });
    });

    describe("/me handling", () => {
        it("prefixes the Twitch-bound message with /me when the option is on", async () => {
            await fire({
                effect: makeEffect({ me: true }),
                trigger: COMMAND_TRIGGER
            });

            expect(mockDispatchSend).toHaveBeenCalledWith(
                "/me hello world",
                expect.objectContaining({ destination: "both" })
            );
        });

        it("leaves the message untouched for twitch-only sends without /me", async () => {
            await fire({
                effect: makeEffect({ me: true, destination: "twitch" }),
                trigger: COMMAND_TRIGGER
            });

            expect(mockDispatchSend).toHaveBeenCalledWith(
                "/me hello world",
                expect.objectContaining({ destination: "twitch" })
            );
        });
    });

    describe("whisper (Twitch-only)", () => {
        beforeEach(() => {
            mockGetUserByName.mockResolvedValue({ id: "target-user-id" });
        });

        it("whispers via Twitch and never touches the dispatch layer", async () => {
            const result = await fire({
                effect: makeEffect({ whisper: "someuser" }),
                trigger: COMMAND_TRIGGER
            });

            expect(result).toBe(true);
            expect(mockGetUserByName).toHaveBeenCalledWith("someuser");
            expect(mockSendWhisper).toHaveBeenCalledWith("target-user-id", "hello world", true);
            expect(mockDispatchSend).not.toHaveBeenCalled();
        });

        it("keeps the streamer voice when the chatter option is Streamer", async () => {
            await fire({
                effect: makeEffect({ whisper: "someuser", chatter: "Streamer" }),
                trigger: COMMAND_TRIGGER
            });

            expect(mockSendWhisper).toHaveBeenCalledWith("target-user-id", "hello world", false);
        });

        it("still applies the /me prefix to whispers when set", async () => {
            await fire({
                effect: makeEffect({ whisper: "someuser", me: true }),
                trigger: COMMAND_TRIGGER
            });

            expect(mockSendWhisper).toHaveBeenCalledWith("target-user-id", "/me hello world", true);
        });
    });

    describe("pin (Twitch-side result)", () => {
        it("pins using the Twitch dispatch result when the send succeeded", async () => {
            await fire({
                effect: makeEffect({ pin: true, pinDuration: "600" }),
                trigger: COMMAND_TRIGGER
            });

            expect(mockPinChatMessage).toHaveBeenCalledWith("twitch-msg-1", 600);
        });

        it("clamps pin durations into the 30-1800s API range", async () => {
            await fire({
                effect: makeEffect({ pin: true, pinDuration: "10" }),
                trigger: COMMAND_TRIGGER
            });
            expect(mockPinChatMessage).toHaveBeenLastCalledWith("twitch-msg-1", 30);

            await fire({
                effect: makeEffect({ pin: true, pinDuration: "2000" }),
                trigger: COMMAND_TRIGGER
            });
            expect(mockPinChatMessage).toHaveBeenLastCalledWith("twitch-msg-1", 1800);

            await fire({
                effect: makeEffect({ pin: true, pinUntilEndOfStream: true }),
                trigger: COMMAND_TRIGGER
            });
            expect(mockPinChatMessage).toHaveBeenLastCalledWith("twitch-msg-1", undefined);

            await fire({
                effect: makeEffect({ pin: true, pinDuration: "not-a-number" }),
                trigger: COMMAND_TRIGGER
            });
            expect(mockPinChatMessage).toHaveBeenLastCalledWith("twitch-msg-1", undefined);
        });

        it("does not pin when the Twitch send failed", async () => {
            mockDispatchSend.mockResolvedValue({
                twitch: { attempted: true, success: false, isSlashCommand: false },
                youtube: { attempted: true, success: true }
            });

            await fire({
                effect: makeEffect({ pin: true, pinDuration: "600" }),
                trigger: COMMAND_TRIGGER
            });

            expect(mockPinChatMessage).not.toHaveBeenCalled();
        });

        it("does not pin slash-command sends", async () => {
            mockDispatchSend.mockResolvedValue({
                twitch: { attempted: true, success: true, isSlashCommand: true },
                youtube: { attempted: false, success: false, skipped: "not-live" }
            });

            await fire({
                effect: makeEffect({ pin: true, pinDuration: "600" }),
                trigger: COMMAND_TRIGGER
            });

            expect(mockPinChatMessage).not.toHaveBeenCalled();
        });

        it("does not pin (nor warn about a failed send) for youtube-only destinations", async () => {
            mockDispatchSend.mockResolvedValue({
                twitch: { attempted: false, success: false, skipped: "empty-message" },
                youtube: { attempted: true, success: true }
            });

            await fire({
                effect: makeEffect({ pin: true, pinDuration: "600", destination: "youtube" }),
                trigger: COMMAND_TRIGGER
            });

            expect(mockPinChatMessage).not.toHaveBeenCalled();
        });
    });
});
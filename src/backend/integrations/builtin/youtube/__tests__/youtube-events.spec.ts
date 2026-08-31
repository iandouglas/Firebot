/**
 * WS-7: the "youtube" event source.
 *
 * - registration smoke test: source registered, all events present, manualMetadata
 *   + activityFeed shapes valid, variables registered
 * - table-driven ingest-kind → event-id/payload mapping over the shared
 *   `youtubeChatEvents` emitter ("chat-message" delivers YouTubeIngestMessage)
 * - null-safety + subscription lifecycle
 *
 * No network; all collaborators mocked per WS-1/WS-3 conventions.
 */

jest.mock("../../../../events/event-manager", () => ({
    EventManager: {
        registerEventSource: jest.fn(),
        unregisterEventSource: jest.fn(),
        triggerEvent: jest.fn(),
        triggerUiRefresh: jest.fn()
    }
}));

jest.mock("../../../../variables/replace-variable-manager", () => ({
    ReplaceVariableManager: {
        registerReplaceVariable: jest.fn(),
        unregisterReplaceVariable: jest.fn()
    }
}));

jest.mock("../../../../logger-cache", () => ({
    LoggerCache: {
        getLogger: jest.fn().mockReturnValue({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn()
        })
    }
}));

import { EventManager } from "../../../../events/event-manager";
import { ReplaceVariableManager } from "../../../../variables/replace-variable-manager";
import { EventId, YOUTUBE_EVENT_SOURCE_ID, youTubeEventSource } from "../events/event-definitions";
import {
    handleYouTubeIngestMessage,
    subscribeYouTubeIngestEvents,
    triggerMembersOnlyMode,
    unsubscribeYouTubeIngestEvents
} from "../events/event-handler";
import { registerYouTubeEvents } from "../events/index";
import { variableHandles, youTubeVariables } from "../variables/index";
import { youtubeChatEvents, type YouTubeIngestMessage, type YouTubeIngestMessageKind } from "../contracts";

const registerEventSourceMock = EventManager.registerEventSource as unknown as jest.Mock;
const triggerEventMock = EventManager.triggerEvent as unknown as jest.Mock;
const registerReplaceVariableMock = ReplaceVariableManager.registerReplaceVariable as unknown as jest.Mock;

const AUTHOR_BASE = {
    channelId: "UCFirebotTestAuthor00000001",
    displayName: "MemberMcGee",
    avatarUrl: "https://example.com/avatar.png",
    isOwner: false,
    isModerator: false,
    isSponsor: false
};

// Snapshot values (not references) before clearMocks wipes mock.calls.
let registeredSource: { id: string; name: string; events: Array<{ id: string }> };
let registeredVariableHandles: string[];
let registrationCallCountAtBoot = 0;

beforeAll(() => {
    // Registration is idempotent — a second call must be a no-op.
    registerYouTubeEvents();
    registerYouTubeEvents();

    registrationCallCountAtBoot = registerEventSourceMock.mock.calls.length;
    registeredSource = registerEventSourceMock.mock.calls[0][0];
    registeredVariableHandles = registerReplaceVariableMock.mock.calls.map(call => call[0].definition.handle);
});

beforeEach(() => {
    jest.clearAllMocks();
    unsubscribeYouTubeIngestEvents();
    subscribeYouTubeIngestEvents();
});

function makeIngestMessage(
    kind: YouTubeIngestMessageKind,
    overrides: Partial<YouTubeIngestMessage> = {}
): YouTubeIngestMessage {
    return {
        kind: kind,
        messageId: "yt-message-1",
        author: { ...AUTHOR_BASE },
        text: undefined,
        publishedAt: "2026-01-01T12:00:00Z",
        payload: undefined,
        ...overrides
    };
}

describe("registration smoke test", () => {
    it("registers the youtube event source exactly once even across repeated init", () => {
        expect(registrationCallCountAtBoot).toBe(1);
        expect(registeredSource.id).toBe(YOUTUBE_EVENT_SOURCE_ID);
        expect(registeredSource.name).toBe("YouTube");
    });

    it("lists every WS-7 event id in the locked order", () => {
        const eventIds = registeredSource.events.map(e => e.id);

        expect(eventIds).toEqual([
            EventId.STREAM_ONLINE,
            EventId.STREAM_OFFLINE,
            EventId.CHAT_MESSAGE,
            EventId.MEMBER_JOIN,
            EventId.MEMBER_MILESTONE,
            EventId.GIFT_MEMBERSHIP,
            EventId.GIFT_MEMBERSHIP_RECEIVED,
            EventId.SUPER_CHAT,
            EventId.SUPER_STICKER,
            EventId.MEMBERS_ONLY_MODE_STARTED,
            EventId.MEMBERS_ONLY_MODE_ENDED
        ]);
    });

    it("marks every event as integration-sourced with description, activity feed and test-fire metadata", () => {
        for (const event of youTubeEventSource.events) {
            expect(event.isIntegration).toBe(true);
            expect(event.description).toBeTruthy();

            // chat-message intentionally has no activity feed entry (mirrors the
            // twitch chat-message convention); everything else feeds the activity.
            if (event.id !== EventId.CHAT_MESSAGE) {
                expect(event.activityFeed).toBeDefined();
                expect(event.activityFeed.icon.length).toBeGreaterThan(0);
                expect(event.activityFeed.getMessage(event.manualMetadata ?? {})).toBeTruthy();
            }

            expect(event.manualMetadata).toBeDefined();
            expect(Object.keys(event.manualMetadata ?? {}).length).toBeGreaterThan(0);
        }
    });

    it("gives every event plausible test-fire metadata (username, userId, event-specific fields)", () => {
        const byId = Object.fromEntries(youTubeEventSource.events.map(e => [e.id, e]));

        expect(byId["stream-online"].manualMetadata).toMatchObject({
            username: expect.any(String),
            userId: expect.any(String),
            videoId: expect.any(String),
            liveChatId: expect.any(String),
            viewerCount: expect.any(Number)
        });

        expect(byId["super-chat"].manualMetadata).toMatchObject({
            username: expect.any(String),
            userId: expect.any(String),
            superChatAmountDisplay: "$5.00",
            superChatCurrency: "USD",
            superChatTier: expect.any(Number),
            superChatMessage: expect.any(String)
        });

        expect(byId["member-milestone"].manualMetadata).toMatchObject({
            username: "MemberMcGee",
            memberLevelName: expect.any(String),
            memberMonth: expect.any(Number),
            memberIsUpgrade: expect.any(Boolean),
            memberMessage: expect.any(String)
        });

        expect(byId["gift-membership"].manualMetadata).toMatchObject({
            giftCount: expect.any(Number),
            gifterChannelId: expect.any(String),
            gifterDisplayName: expect.any(String)
        });

        expect(byId["gift-membership-received"].manualMetadata).toMatchObject({
            username: expect.any(String),
            gifterChannelId: expect.any(String),
            gifterDisplayName: expect.any(String)
        });
    });

    it("registers all nine youtube replace variables once, with manual triggers", () => {
        expect(registeredVariableHandles).toEqual(variableHandles);
        expect(variableHandles).toEqual([
            "youtubeViewerCount",
            "superChatAmount",
            "superChatCurrency",
            "superChatTier",
            "superChatMessage",
            "memberLevelName",
            "memberMonth",
            "memberIsUpgrade",
            "giftedMembershipCount"
        ]);

        for (const definition of youTubeVariables) {
            expect(definition.definition.triggers).toMatchObject({ manual: true });
        }
    });
});

type MappingCase = {
    name: string;
    kind: YouTubeIngestMessageKind;
    payload?: YouTubeIngestMessage["payload"];
    text?: string;
    author?: Partial<typeof AUTHOR_BASE>;
    expectedEventId: string;
    expectedMetadata: Record<string, unknown>;
};

describe("ingest kind → event mapping", () => {
    const mappingCases: MappingCase[] = [
        {
            name: "text → chat-message with messageText, messageId and roles from author flags",
            kind: "text",
            text: "Hello YouTube chat!",
            author: { isOwner: true, isModerator: true, isSponsor: true },
            expectedEventId: EventId.CHAT_MESSAGE,
            expectedMetadata: {
                username: "MemberMcGee",
                userDisplayName: "MemberMcGee",
                userId: AUTHOR_BASE.channelId,
                messageId: "yt-message-1",
                messageText: "Hello YouTube chat!",
                youtubeUserRoles: ["broadcaster", "moderator", "member"]
            }
        },
        {
            name: "member-join → member-join with memberLevelName",
            kind: "member-join",
            payload: { memberLevelName: "Legend" },
            expectedEventId: EventId.MEMBER_JOIN,
            expectedMetadata: {
                username: "MemberMcGee",
                userId: AUTHOR_BASE.channelId,
                memberLevelName: "Legend"
            }
        },
        {
            name: "member-milestone → member-milestone with month, level, upgrade flag and message",
            kind: "member-milestone",
            payload: { memberLevelName: "Legend", memberMonth: 24, isUpgrade: true },
            text: "Two years!",
            expectedEventId: EventId.MEMBER_MILESTONE,
            expectedMetadata: {
                userDisplayName: "MemberMcGee",
                userId: AUTHOR_BASE.channelId,
                memberLevelName: "Legend",
                memberMonth: 24,
                memberIsUpgrade: true,
                memberMessage: "Two years!"
            }
        },
        {
            name: "gift-membership → gift-membership; author is the gifter",
            kind: "gift-membership",
            payload: { memberLevelName: "Member", giftCount: 5, gifterChannelId: AUTHOR_BASE.channelId },
            expectedEventId: EventId.GIFT_MEMBERSHIP,
            expectedMetadata: {
                username: "MemberMcGee",
                userId: AUTHOR_BASE.channelId,
                giftCount: 5,
                gifterChannelId: AUTHOR_BASE.channelId,
                gifterDisplayName: "MemberMcGee",
                memberLevelName: "Member"
            }
        },
        {
            name: "gift-membership-received → gifter channel id surfaced separately from the receiving author",
            kind: "gift-membership-received",
            payload: { memberLevelName: "Member", gifterChannelId: "UCGiftGuru000000000000001" },
            expectedEventId: EventId.GIFT_MEMBERSHIP_RECEIVED,
            expectedMetadata: {
                username: "MemberMcGee",
                userId: AUTHOR_BASE.channelId,
                memberLevelName: "Member",
                gifterChannelId: "UCGiftGuru000000000000001"
            }
        },
        {
            name: "super-chat → super-chat with amount display, currency, tier and message",
            kind: "super-chat",
            payload: {
                superChatAmountDisplay: "$5.00",
                superChatAmountMicros: "5000000",
                superChatCurrency: "USD",
                superChatTier: 2
            },
            text: "Love the stream!",
            expectedEventId: EventId.SUPER_CHAT,
            expectedMetadata: {
                username: "MemberMcGee",
                userId: AUTHOR_BASE.channelId,
                superChatAmountDisplay: "$5.00",
                superChatAmountMicros: "5000000",
                superChatCurrency: "USD",
                superChatTier: 2,
                superChatMessage: "Love the stream!"
            }
        },
        {
            name: "super-sticker → super-sticker; no comment so superChatMessage is null",
            kind: "super-sticker",
            payload: {
                superChatAmountDisplay: "$2.00",
                superChatCurrency: "EUR",
                superChatTier: 1
            },
            expectedEventId: EventId.SUPER_STICKER,
            expectedMetadata: {
                username: "MemberMcGee",
                userDisplayName: "MemberMcGee",
                userId: AUTHOR_BASE.channelId,
                superChatAmountDisplay: "$2.00",
                superChatCurrency: "EUR",
                superChatTier: 1,
                superChatMessage: null
            }
        }
    ];

    for (const mappingCase of mappingCases) {
        it(mappingCase.name, () => {
            youtubeChatEvents.emit("chat-message", makeIngestMessage(mappingCase.kind, {
                payload: mappingCase.payload,
                text: mappingCase.text,
                author: { ...AUTHOR_BASE, ...(mappingCase.author ?? {}) }
            }));

            expect(triggerEventMock).toHaveBeenCalledWith(
                YOUTUBE_EVENT_SOURCE_ID,
                mappingCase.expectedEventId,
                expect.objectContaining(mappingCase.expectedMetadata)
            );
        });
    }

    it("gift-membership-received reports gifterDisplayName null when only the channel id arrived", () => {
        youtubeChatEvents.emit("chat-message", makeIngestMessage("gift-membership-received", {
            payload: { memberLevelName: "Member", gifterChannelId: "UCGiftGuru000000000000001" }
        }));

        const metadata = triggerEventMock.mock.calls[0][2] as Record<string, unknown>;
        expect(metadata.gifterDisplayName).toBeNull();
    });

    it("derives superChatAmountDisplay from amountMicros when YouTube omits the display string", () => {
        youtubeChatEvents.emit("chat-message", makeIngestMessage("super-chat", {
            payload: { superChatAmountMicros: "2000000", superChatCurrency: "USD", superChatTier: 1 }
        }));

        expect(triggerEventMock).toHaveBeenCalledWith(YOUTUBE_EVENT_SOURCE_ID, EventId.SUPER_CHAT, expect.objectContaining({
            superChatAmountDisplay: "$2.00"
        }));
    });

    it("maps no event at all for the banned ingest kind (WS-8 owns moderation)", () => {
        youtubeChatEvents.emit("chat-message", makeIngestMessage("banned"));

        expect(triggerEventMock).not.toHaveBeenCalled();
    });

    it("tolerates messages without payload and still triggers (null-safe fields)", () => {
        youtubeChatEvents.emit("chat-message", makeIngestMessage("member-join"));

        expect(triggerEventMock).toHaveBeenCalledWith(YOUTUBE_EVENT_SOURCE_ID, EventId.MEMBER_JOIN, expect.objectContaining({
            memberLevelName: null
        }));
    });

    it("ignores malformed ingest messages (missing author) without throwing", () => {
        youtubeChatEvents.emit("chat-message", makeIngestMessage("text", { author: undefined }));

        expect(triggerEventMock).not.toHaveBeenCalled();
    });
});

describe("members-only mode helper", () => {
    it("triggerMembersOnlyMode(true) fires members-only-mode-started with channel metadata", () => {
        triggerMembersOnlyMode(true, { channelTitle: "FirebotTestChannel", channelId: "UCFirebotTestChannel0000001" });

        expect(triggerEventMock).toHaveBeenCalledWith(YOUTUBE_EVENT_SOURCE_ID, EventId.MEMBERS_ONLY_MODE_STARTED, {
            username: "FirebotTestChannel",
            userDisplayName: "FirebotTestChannel",
            userId: "UCFirebotTestChannel0000001"
        });
    });

    it("triggerMembersOnlyMode(false) fires members-only-mode-ended", () => {
        triggerMembersOnlyMode(false);

        expect(triggerEventMock).toHaveBeenCalledWith(YOUTUBE_EVENT_SOURCE_ID, EventId.MEMBERS_ONLY_MODE_ENDED, expect.objectContaining({
            username: "YouTube Channel"
        }));
    });
});

describe("subscription lifecycle", () => {
    it("unsubscribing stops the mapping; resubscribing restores it", () => {
        unsubscribeYouTubeIngestEvents();

        youtubeChatEvents.emit("chat-message", makeIngestMessage("member-join"));
        expect(triggerEventMock).not.toHaveBeenCalled();

        subscribeYouTubeIngestEvents();
        youtubeChatEvents.emit("chat-message", makeIngestMessage("member-join"));
        expect(triggerEventMock).toHaveBeenCalledTimes(1);
    });

    it("handles a completely unrecognized ingest payload gracefully", () => {
        expect(() => handleYouTubeIngestMessage(null as unknown as YouTubeIngestMessage)).not.toThrow();
        expect(() => handleYouTubeIngestMessage(undefined as unknown as YouTubeIngestMessage)).not.toThrow();
        expect(triggerEventMock).not.toHaveBeenCalled();
    });
});
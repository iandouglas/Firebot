import type { EventDefinition, EventSource } from "../../../../../types/events";

/**
 * WS-7: the "youtube" event source (decision D8 — separate `youtube:*` event ids,
 * no reuse of `twitch:*` bindings).
 *
 * The same event ids are used as second half of:
 * - variable triggers (`youtube:<eventId>`, see ../variables),
 * - event settings bindings in the Events UI, and
 * - the ingest mapping in ./event-handler.ts.
 *
 * `manualMetadata` values are used for test-firing from the Events UI (plausible
 * defaults; they must mirror the real payload keys documented in ./event-handler.ts
 * so variables/conditions used by effects resolve during a manual fire).
 */
export const YOUTUBE_EVENT_SOURCE_ID = "youtube";

export const EventId = {
    STREAM_ONLINE: "stream-online",
    STREAM_OFFLINE: "stream-offline",
    CHAT_MESSAGE: "chat-message",
    MEMBER_JOIN: "member-join",
    MEMBER_MILESTONE: "member-milestone",
    GIFT_MEMBERSHIP: "gift-membership",
    GIFT_MEMBERSHIP_RECEIVED: "gift-membership-received",
    SUPER_CHAT: "super-chat",
    SUPER_STICKER: "super-sticker",
    MEMBERS_ONLY_MODE_STARTED: "members-only-mode-started",
    MEMBERS_ONLY_MODE_ENDED: "members-only-mode-ended"
} as const;

export type YouTubeEventId = typeof EventId[keyof typeof EventId];

type IntegrationEventDefinition = EventDefinition & {
    /** Flags the event as needing a linked integration (Events UI tooltip). */
    isIntegration?: boolean;
};

export type YouTubeEventSource = Omit<EventSource, "events"> & {
    events: IntegrationEventDefinition[];
};

// Test-fire defaults mirror the real event payloads (see ./event-handler.ts).
const DEFAULT_UX = {
    username: "MemberMcGee",
    userDisplayName: "MemberMcGee",
    userId: "UCFirebotTestChannel00000001"
};

export const youTubeEventSource: YouTubeEventSource = {
    id: YOUTUBE_EVENT_SOURCE_ID,
    name: "YouTube",
    description: "Events from your YouTube channel and live chat (members, gifts, super chats, and more)",
    events: [
        {
            id: EventId.STREAM_ONLINE,
            name: "Stream Online",
            description: "When your YouTube broadcast goes live.",
            cached: false,
            manualMetadata: {
                ...DEFAULT_UX,
                username: "FirebotTestChannel",
                userDisplayName: "FirebotTestChannel",
                videoId: "dQw4w9WgXcQ",
                liveChatId: "Cg0KC2ZpcmVib3RsaXZlKicSGhdDZzBLcWZpcmVib3Rs",
                viewerCount: 5
            },
            isIntegration: true,
            activityFeed: {
                icon: "fad fa-play-circle",
                getMessage: (eventData) => {
                    return `**${eventData.userDisplayName ?? eventData.username}** went live on YouTube`;
                }
            }
        },
        {
            id: EventId.STREAM_OFFLINE,
            name: "Stream Offline",
            description: "When your YouTube broadcast ends.",
            cached: false,
            manualMetadata: {
                username: "FirebotTestChannel",
                userDisplayName: "FirebotTestChannel",
                userId: "UCFirebotTestChannel00000001"
            },
            isIntegration: true,
            activityFeed: {
                icon: "fad fa-stop-circle",
                getMessage: (eventData) => {
                    return `**${eventData.username}**'s YouTube stream ended`;
                }
            }
        },
        {
            id: EventId.CHAT_MESSAGE,
            name: "Chat Message",
            description: "When a text message is sent in your YouTube live chat.",
            cached: false,
            manualMetadata: {
                username: "ChatMcChatface",
                userDisplayName: "ChatMcChatface",
                userId: "UCFirebotTestChatter00000001",
                messageId: "fake-youtube-chat-message-id",
                messageText: "Hello YouTube chat!",
                youtubeUserRoles: []
            },
            isIntegration: true
        },
        {
            id: EventId.MEMBER_JOIN,
            name: "New Member",
            description: "When someone joins your YouTube channel membership.",
            cached: false,
            manualMetadata: {
                ...DEFAULT_UX,
                memberLevelName: "Member"
            },
            isIntegration: true,
            activityFeed: {
                icon: "fas fa-crown",
                getMessage: (eventData) => {
                    const level = eventData.memberLevelName ?? "Member";
                    return `**${eventData.username}** became a YouTube member (level ${level})`;
                }
            }
        },
        {
            id: EventId.MEMBER_MILESTONE,
            name: "Member Milestone",
            description: "When a YouTube member reaches a milestone month and shares a message.",
            cached: false,
            manualMetadata: {
                ...DEFAULT_UX,
                memberLevelName: "Member",
                memberMonth: 12,
                memberIsUpgrade: false,
                memberMessage: "One year — been here since day one!"
            },
            isIntegration: true,
            activityFeed: {
                icon: "fas fa-medal",
                getMessage: (eventData) => {
                    let message = `**${eventData.username}** hit **${eventData.memberMonth} month(s)** as a YouTube member`;
                    if (eventData.memberIsUpgrade === true) {
                        message += " (level upgrade)";
                    }
                    const memberMessage = eventData.memberMessage;
                    if (memberMessage && String(memberMessage).length > 0) {
                        message += `: *${memberMessage}*`;
                    }
                    return message;
                }
            }
        },
        {
            id: EventId.GIFT_MEMBERSHIP,
            name: "Gifted Memberships",
            description: "When someone gifts one or more YouTube channel memberships to others.",
            cached: false,
            manualMetadata: {
                username: "GiftGuru",
                userDisplayName: "GiftGuru",
                userId: "UCFirebotGiftGuru000000001",
                memberLevelName: "Member",
                giftCount: 3,
                gifterChannelId: "UCFirebotGiftGuru000000001",
                gifterDisplayName: "GiftGuru"
            },
            isIntegration: true,
            activityFeed: {
                icon: "fas fa-gift",
                getMessage: (eventData) => {
                    return `**${eventData.username}** gifted **${eventData.giftCount}** YouTube membership(s)`;
                }
            }
        },
        {
            id: EventId.GIFT_MEMBERSHIP_RECEIVED,
            name: "Gifted Membership Received",
            description: "When a viewer receives a gifted YouTube channel membership.",
            cached: false,
            manualMetadata: {
                username: "LuckyViewer",
                userDisplayName: "LuckyViewer",
                userId: "UCFirebotLuckyViewer00001",
                memberLevelName: "Member",
                gifterChannelId: "UCFirebotGiftGuru000000001",
                gifterDisplayName: "GiftGuru"
            },
            isIntegration: true,
            activityFeed: {
                icon: "fas fa-gift",
                getMessage: (eventData) => {
                    const gifter = eventData.gifterDisplayName ?? "Someone";
                    return `**${eventData.username}** received a gifted YouTube membership from **${gifter}**`;
                }
            }
        },
        {
            id: EventId.SUPER_CHAT,
            name: "Super Chat",
            description: "When someone purchases a super chat in your YouTube live chat.",
            cached: false,
            manualMetadata: {
                username: "SuperChatSally",
                userDisplayName: "SuperChatSally",
                userId: "UCFirebotSuperSally000001",
                superChatAmountDisplay: "$5.00",
                superChatAmountMicros: "5000000",
                superChatCurrency: "USD",
                superChatTier: 2,
                superChatMessage: "Love the streams, keep it up!"
            },
            isIntegration: true,
            activityFeed: {
                icon: "fad fa-comment-dollar",
                getMessage: (eventData) => {
                    let message = `**${eventData.username}** sent a **${eventData.superChatAmountDisplay}** super chat`;
                    const superChatMessage = eventData.superChatMessage;
                    if (superChatMessage && String(superChatMessage).length > 0) {
                        message += `: *${superChatMessage}*`;
                    }
                    return message;
                }
            }
        },
        {
            id: EventId.SUPER_STICKER,
            name: "Super Sticker",
            description: "When someone purchases a super sticker in your YouTube live chat.",
            cached: false,
            manualMetadata: {
                username: "SuperChatSally",
                userDisplayName: "SuperChatSally",
                userId: "UCFirebotSuperSally000001",
                superChatAmountDisplay: "$2.00",
                superChatAmountMicros: "2000000",
                superChatCurrency: "USD",
                superChatTier: 1,
                superChatMessage: null
            },
            isIntegration: true,
            activityFeed: {
                icon: "fas fa-sticky-note",
                getMessage: (eventData) => {
                    return `**${eventData.username}** sent a **${eventData.superChatAmountDisplay}** super sticker`;
                }
            }
        },
        {
            id: EventId.MEMBERS_ONLY_MODE_STARTED,
            name: "Members-Only Mode Started",
            description: "When members-only chat mode is turned on for your YouTube live chat.",
            cached: false,
            manualMetadata: {
                username: "FirebotTestChannel",
                userDisplayName: "FirebotTestChannel",
                userId: "UCFirebotTestChannel00000001"
            },
            isIntegration: true,
            activityFeed: {
                icon: "fas fa-lock",
                getMessage: () => {
                    return "YouTube members-only chat mode was **enabled**";
                }
            }
        },
        {
            id: EventId.MEMBERS_ONLY_MODE_ENDED,
            name: "Members-Only Mode Ended",
            description: "When members-only chat mode is turned off for your YouTube live chat.",
            cached: false,
            manualMetadata: {
                username: "FirebotTestChannel",
                userDisplayName: "FirebotTestChannel",
                userId: "UCFirebotTestChannel00000001"
            },
            isIntegration: true,
            activityFeed: {
                icon: "fas fa-lock-open",
                getMessage: () => {
                    return "YouTube members-only chat mode was **disabled**";
                }
            }
        }
    ]
};
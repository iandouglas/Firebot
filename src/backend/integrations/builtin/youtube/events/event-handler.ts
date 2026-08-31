import type {
    YouTubeIngestMessage,
    YouTubeIngestMessageAuthor,
    YouTubeIngestMessageKind,
    YouTubeIngestMessagePayload
} from "../contracts";
import { youtubeChatEvents } from "../contracts";
import { LoggerCache } from "../../../../logger-cache";

import { EventManager } from "../../../../events/event-manager";
import { EventId, YOUTUBE_EVENT_SOURCE_ID } from "./event-definitions";

const logger = LoggerCache.getLogger("YouTube");

/**
 * WS-7: maps YouTube ingest messages (WS-4 hands them off through the shared
 * `youtubeChatEvents` "chat-message" event) into Firebot events on the
 * "youtube" event source.
 *
 * === Event metadata contract (also used by the WS-10 frontend and test-firing
 * manualMetadata in ./event-definitions.ts) ===
 *
 * All events carry `username`, `userDisplayName` (YouTube display name —
 * YouTube has no separate login handle, both mirror `author.displayName`
 * lowercased/verbatim) and `userId` (RAW YouTube channel id, `UC...` — scope
 * to the viewer DB only happens inside DB layers, WS invariant #1).
 *
 * - chat-message:     messageId, messageText, youtubeUserRoles
 *                     ("broadcaster" | "moderator" | "member")
 * - stream-online:    videoId, liveChatId, viewerCount (fired by WS-2's
 *                     triggers/stream-events.ts, metadata shape mirrored here)
 * - stream-offline:   (no extra fields; fired by WS-2)
 * - member-join:      memberLevelName
 * - member-milestone: memberLevelName, memberMonth, memberIsUpgrade, memberMessage
 * - gift-membership:  gifterChannelId, gifterDisplayName, giftCount, memberLevelName
 *                     (the message author IS the gifter)
 * - gift-membership-received: memberLevelName, gifterChannelId, gifterDisplayName
 *                     (the message author IS the gift recipient; YouTube only
 *                     provides the gifter's channel id, so gifterDisplayName is
 *                     null unless the ingest payload ever carries one)
 * - super-chat / super-sticker:
 *                     superChatAmountDisplay, superChatAmountMicros,
 *                     superChatCurrency, superChatTier, superChatMessage
 * - members-only-mode-started/-ended:
 *                     channel-level metadata only (no per-user message exists
 *                     for these); use triggerMembersOnlyMode() — see below.
 *
 * The "banned" ingest kind intentionally maps to no event (moderation parity is
 * WS-8's moderation API surface, not an event feed item).
 */

type EventTrigger = {
    eventId: string;
    metadata: Record<string, unknown>;
};

interface TriggerContext {
    message: YouTubeIngestMessage;
    author: YouTubeIngestMessageAuthor;
    payload: YouTubeIngestMessagePayload | undefined;
    /** The userComment/message text, when the message carries one. */
    text: string | undefined;
}

/**
 * Derives a display string for a super chat/sticker amount. Prefers
 * `superChatAmountDisplay` (YouTube already formats it); falls back to computing
 * a display from `superChatAmountMicros` (micros = amount × 1,000,000).
 */
function superChatAmountDisplay(ctx: TriggerContext): string | null {
    const display = ctx.payload?.superChatAmountDisplay;
    if (display != null && display.trim() !== "") {
        return display;
    }

    const micros = ctx.payload?.superChatAmountMicros;
    if (micros != null) {
        const amount = Number(micros) / 1_000_000;
        if (!isNaN(amount)) {
            const currency = ctx.payload?.superChatCurrency;
            if (currency) {
                try {
                    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
                } catch {
                    // fall through to a bare number for unknown currency codes
                }
            }
            return `$${amount.toFixed(2)}`;
        }
    }

    return null;
}

/** Per-user role labels derived from the ingest author flags. */
function youtubeUserRoles(author: YouTubeIngestMessageAuthor): string[] {
    const roles: string[] = [];
    if (author.isOwner) {
        roles.push("broadcaster");
    }
    if (author.isModerator) {
        roles.push("moderator");
    }
    if (author.isSponsor) {
        roles.push("member");
    }
    return roles;
}

function userMetadata(author: YouTubeIngestMessageAuthor): Record<string, unknown> {
    return {
        username: author.displayName,
        userDisplayName: author.displayName,
        userId: author.channelId
    };
}

/**
 * Table mapping ingest message kinds → youtube event ids. One entry per kind so
 * a new ingest kind fails type-checking here until it is mapped explicitly.
 */
const triggerBuilders: Record<YouTubeIngestMessageKind, (ctx: TriggerContext) => EventTrigger | null> = {
    "text": (ctx) => ({
        eventId: EventId.CHAT_MESSAGE,
        metadata: {
            ...userMetadata(ctx.author),
            messageId: ctx.message.messageId,
            messageText: ctx.message.text ?? "",
            youtubeUserRoles: youtubeUserRoles(ctx.author)
        }
    }),
    "member-join": (ctx) => ({
        eventId: EventId.MEMBER_JOIN,
        metadata: {
            ...userMetadata(ctx.author),
            memberLevelName: ctx.payload?.memberLevelName ?? null
        }
    }),
    "member-milestone": (ctx) => ({
        eventId: EventId.MEMBER_MILESTONE,
        metadata: {
            ...userMetadata(ctx.author),
            memberLevelName: ctx.payload?.memberLevelName ?? null,
            memberMonth: ctx.payload?.memberMonth ?? null,
            memberIsUpgrade: ctx.payload?.isUpgrade === true,
            memberMessage: ctx.text ?? ""
        }
    }),
    "gift-membership": (ctx) => ({
        eventId: EventId.GIFT_MEMBERSHIP,
        metadata: {
            ...userMetadata(ctx.author),
            memberLevelName: ctx.payload?.memberLevelName ?? null,
            giftCount: ctx.payload?.giftCount ?? 0,
            // For a gifting message the author IS the gifter; the payload value
            // is redundant but takes precedence when WS-4 supplies it.
            gifterChannelId: ctx.payload?.gifterChannelId ?? ctx.author.channelId,
            gifterDisplayName: ctx.author.displayName
        }
    }),
    "gift-membership-received": (ctx) => ({
        eventId: EventId.GIFT_MEMBERSHIP_RECEIVED,
        metadata: {
            ...userMetadata(ctx.author),
            memberLevelName: ctx.payload?.memberLevelName ?? null,
            gifterChannelId: ctx.payload?.gifterChannelId ?? null,
            // YouTube's giftMembershipReceivedEvent gives no gifter display
            // name — a gifterDisplayName on the payload would be a forward
            // extension of the ingest contract.
            gifterDisplayName:
                (ctx.payload as (YouTubeIngestMessagePayload & { gifterDisplayName?: string }) | undefined)
                    ?.gifterDisplayName ?? null
        }
    }),
    "super-chat": (ctx) => ({
        eventId: EventId.SUPER_CHAT,
        metadata: {
            ...userMetadata(ctx.author),
            superChatAmountDisplay: superChatAmountDisplay(ctx),
            superChatAmountMicros: ctx.payload?.superChatAmountMicros ?? null,
            superChatCurrency: ctx.payload?.superChatCurrency ?? null,
            superChatTier: ctx.payload?.superChatTier ?? null,
            superChatMessage: ctx.text ?? ""
        }
    }),
    "super-sticker": (ctx) => ({
        eventId: EventId.SUPER_STICKER,
        metadata: {
            ...userMetadata(ctx.author),
            superChatAmountDisplay: superChatAmountDisplay(ctx),
            superChatAmountMicros: ctx.payload?.superChatAmountMicros ?? null,
            superChatCurrency: ctx.payload?.superChatCurrency ?? null,
            superChatTier: ctx.payload?.superChatTier ?? null,
            // Sticker messages carry no user comment on YouTube.
            superChatMessage: ctx.text ?? null
        }
    }),
    // Tombstones of deleted/banned users are not event-worthy (WS-8 owns
    // moderation surfaces).
    "banned": () => null
};

/**
 * Maps one ingest message to a Firebot event trigger. Unknown/unmapped kinds
 * (e.g. "banned") are skipped with a debug log.
 */
export function handleYouTubeIngestMessage(message: YouTubeIngestMessage): void {
    if (message == null || message.author == null) {
        logger.warn("YouTube ingest message missing author; skipping event mapping.");
        return;
    }

    const builder = triggerBuilders[message.kind];
    if (builder == null) {
        logger.debug(`No youtube event mapping for ingest kind "${String(message.kind)}"; skipping.`);
        return;
    }

    const trigger = builder({
        message,
        author: message.author,
        payload: message.payload,
        text: message.text
    });

    if (trigger == null) {
        logger.debug(`Ingest kind "${message.kind}" intentionally maps to no event; skipping.`);
        return;
    }

    void EventManager.triggerEvent(YOUTUBE_EVENT_SOURCE_ID, trigger.eventId, trigger.metadata);
}

let ingestSubscribed = false;

/**
 * Subscribes the event mapping to the shared ingest emitter. Idempotent — safe
 * to call on every integration init.
 */
export function subscribeYouTubeIngestEvents(): void {
    if (ingestSubscribed) {
        return;
    }
    youtubeChatEvents.on("chat-message", handleYouTubeIngestMessage);
    ingestSubscribed = true;
}

/** Removes the ingest subscription (useful for teardown/tests). */
export function unsubscribeYouTubeIngestEvents(): void {
    if (!ingestSubscribed) {
        return;
    }
    youtubeChatEvents.removeListener("chat-message", handleYouTubeIngestMessage);
    ingestSubscribed = false;
}

/**
 * Fires the members-only chat mode events. These modes arrive as
 * `sponsorOnlyModeStartedEvent`/`sponsorOnlyModeEndedEvent` snippet types in the
 * chat feed (they have no per-user author), so the chat ingest maps them here
 * instead of through the YouTubeIngestMessage pipeline.
 */
export function triggerMembersOnlyMode(
    started: boolean,
    context?: { channelTitle?: string; channelId?: string }
): void {
    const channelTitle = context?.channelTitle ?? "YouTube Channel";
    void EventManager.triggerEvent(
        YOUTUBE_EVENT_SOURCE_ID,
        started ? EventId.MEMBERS_ONLY_MODE_STARTED : EventId.MEMBERS_ONLY_MODE_ENDED,
        {
            username: channelTitle,
            userDisplayName: channelTitle,
            userId: context?.channelId ?? null
        }
    );
}
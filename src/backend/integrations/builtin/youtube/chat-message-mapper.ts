import type { FirebotChatMessage } from "../../../../types";

import type {
    YouTubeChatMessageItem,
    YouTubeIngestMessage,
    YouTubeIngestMessageAuthor,
    YouTubeIngestMessagePayload
} from "./contracts";

/**
 * WS-4 chat message mapper — the ONLY place raw `liveChatMessages.list` items
 * are decoded into the shared `YouTubeIngestMessage` contract, and the shared
 * ingest message is rendered as a `FirebotChatMessage`.
 *
 * - `mapChatItemToIngestMessage`: raw item → ingest message. Snippet types with
 *   no ingest kind (sponsorOnlyMode* channel modes, chatEnded) surface as flags
 *   on the result instead — WS-7 owns their event paths.
 * - `ingestMessageToFirebotChatMessage`: text ingest → Firebot chat message
 *   (platform "youtube", RAW channel id in `userId` — WS invariant #1).
 *
 * The mapping table is exhaustive over the snippet types we intentionally
 * handle; anything else maps to null and never throws.
 */

export interface MappedChatItem {
    /** Normalized ingest message, or null when the item carries no message. */
    message: YouTubeIngestMessage | null;
    /** Channel-mode flips have no per-user message and no ingest kind — the ingest calls WS-7's triggerMembersOnlyMode() directly for these. */
    membersOnlyMode: "started" | "ended" | null;
    /** The chat has ended (chatEndedEvent tombstone). */
    chatEnded: boolean;
}

const KIND_BY_SNIPPET_TYPE: Record<string, YouTubeIngestMessage["kind"] | undefined> = {
    textMessageEvent: "text",
    superChatEvent: "super-chat",
    superStickerEvent: "super-sticker",
    newSponsorEvent: "member-join",
    memberMilestoneChatEvent: "member-milestone",
    membershipGiftingEvent: "gift-membership",
    giftMembershipReceivedEvent: "gift-membership-received",
    tombstone: "banned"
};

function firstNumber(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function firstString(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

function asInt(value: unknown): number | undefined {
    const parsed = firstNumber(value);
    if (parsed == null) {
        return undefined;
    }
    const rounded = Math.round(parsed);
    return rounded === parsed ? rounded : undefined;
}

function buildAuthor(item: YouTubeChatMessageItem): YouTubeIngestMessageAuthor {
    return {
        channelId: item.author?.channelId ?? item.authorChannelId ?? "",
        displayName: item.author?.displayName ?? "",
        avatarUrl: item.author?.avatarUrl ?? "",
        isOwner: item.author?.isChatOwner === true,
        isModerator: item.author?.isChatModerator === true,
        isSponsor: item.author?.isChatSponsor === true
    };
}

function buildPayload(item: YouTubeChatMessageItem): YouTubeIngestMessagePayload | undefined {
    const details = (item.details ?? {}) as Record<string, Record<string, unknown> | undefined>;
    const payload: YouTubeIngestMessagePayload = {};

    // Super chat / super sticker amounts (`details` carries the raw snippet).
    const amountDetails = details.superChatDetails ?? details.superStickerDetails;
    if (amountDetails != null) {
        payload.superChatAmountDisplay = firstString(amountDetails.amountDisplayString);
        payload.superChatAmountMicros = firstString(amountDetails.amountMicros);
        payload.superChatCurrency = firstString(amountDetails.currency);
        payload.superChatTier = asInt(amountDetails.tier);
    }

    // Member events.
    const newSponsor = details.newSponsorDetails;
    if (newSponsor != null) {
        payload.memberLevelName = firstString(newSponsor.memberLevelName);
        payload.isUpgrade = newSponsor.isUpgrade === true || newSponsor.memberIsUpgrade === true
            ? true
            : undefined;
    }

    const milestone = details.memberMilestoneChatDetails;
    if (milestone != null) {
        payload.memberLevelName = firstString(milestone.memberLevelName);
        payload.memberMonth = asInt(milestone.memberMonth);
    }

    const gifting = details.membershipGiftingDetails;
    if (gifting != null) {
        payload.giftCount = asInt(gifting.giftMembershipCount);
        payload.memberLevelName = firstString(gifting.memberLevelName);
    }

    const giftReceived = details.giftMembershipReceivedDetails;
    if (giftReceived != null) {
        payload.gifterChannelId = firstString(giftReceived.gifterChannelId);
        payload.memberLevelName = firstString(giftReceived.memberLevelName);
    }

    // Payloads include only keys Youtube actually supplied (no default noise).
    for (const key of Object.keys(payload) as Array<keyof YouTubeIngestMessagePayload>) {
        if (payload[key] === undefined) {
            delete payload[key];
        }
    }

    return Object.keys(payload).length > 0 ? payload : undefined;
}

/**
 * Per-message text, if this snippet type carries one. Sticker events never
 * carry a user comment on purpose (WS-7 renders null for them).
 */
function buildText(item: YouTubeChatMessageItem): string | undefined {
    switch (item.type) {
        case "textMessageEvent": {
            if (item.displayMessage != null && item.displayMessage.trim() !== "") {
                return item.displayMessage;
            }
            const messageText = firstString(
                (item.details?.textMessageDetails as { messageText?: unknown } | undefined)?.messageText
            );
            return messageText ?? item.displayMessage ?? "";
        }

        case "superChatEvent":
        case "memberMilestoneChatEvent":
            return item.displayMessage ?? "";

        // member-join / gifting / received / tombstone: no per-user comment.
        default:
            return undefined;
    }
}

/**
 * Decodes one raw `liveChatMessages.list` item into the ingest contract plus
 * channel-mode flags. Exhaustive over known snippet types; unknown types map
 * to no message (the reader still dedupes their ids). Never throws.
 */
export function mapChatItemToIngestMessage(item: YouTubeChatMessageItem): MappedChatItem {
    if (item == null || typeof item.id !== "string" || item.id === "") {
        return { message: null, membersOnlyMode: null, chatEnded: false };
    }

    const result: MappedChatItem = { message: null, membersOnlyMode: null, chatEnded: false };

    // `chatEndedEvent` can appear alongside other items in a final page.
    if (item.type === "chatEndedEvent") {
        result.chatEnded = true;
    }

    // Members-only chat modes have no per-user message and no ingest kind —
    // the ingest hands these to WS-7's triggerMembersOnlyMode() directly.
    if (item.type === "sponsorOnlyModeStartedEvent") {
        result.membersOnlyMode = "started";
        return result;
    }
    if (item.type === "sponsorOnlyModeEndedEvent") {
        result.membersOnlyMode = "ended";
        return result;
    }

    const kind = KIND_BY_SNIPPET_TYPE[item.type];
    if (kind == null) {
        return result;
    }

    const text = buildText(item);
    const payload = buildPayload(item);

    result.message = {
        kind,
        messageId: item.id,
        author: buildAuthor(item),
        ...(text !== undefined ? { text } : {}),
        publishedAt: item.publishedAt ?? "",
        ...(payload !== undefined ? { payload } : {})
    };

    return result;
}

/** "@Bob!" or "@Bob," → "Bob" (trailing punctuation stripped for readability). */
const MENTION_TOKEN_PATTERN = /^@([A-Za-z0-9_.-]+?)[.,!?;:]?$/;

function buildParts(text: string): FirebotChatMessage["parts"] {
    const parts: FirebotChatMessage["parts"] = [];
    let plainBuffer = "";

    const flushPlain = () => {
        if (plainBuffer.length > 0) {
            parts.push({ type: "text", text: plainBuffer });
            plainBuffer = "";
        }
    };

    for (const token of text.split(/\s+/)) {
        const mentionMatch = token.length > 1 ? MENTION_TOKEN_PATTERN.exec(token) : null;

        if (mentionMatch == null) {
            plainBuffer = plainBuffer === "" ? token : `${plainBuffer} ${token}`;
            continue;
        }

        flushPlain();
        parts.push({
            type: "mention",
            text: token,
            username: mentionMatch[1],
            userId: "",
            userDisplayName: mentionMatch[1]
        });
    }

    flushPlain();
    return parts;
}

/** True when the message text mentions `selfName` (case-insensitive) directly. */
function rolesTextHasMention(text: string, selfName: string | undefined): boolean {
    if (selfName == null) {
        return false;
    }
    return text.split(/\s+/).some((token) => {
        const mentionMatch = token.length > 1 ? MENTION_TOKEN_PATTERN.exec(token) : null;
        return mentionMatch?.[1]?.toLowerCase() === selfName;
    });
}

/**
 * Renders a text ingest message as a Firebot chat message. Non-text kinds
 * return null — they never render as chat text (WS-4/WS-7 agreement:
 * monetization kinds reach the event bus only).
 *
 * `selfDisplayName` (the linked streamer's channel title) drives `tagged` so
 * direct mentions of the channel highlight like Twitch mentions do.
 */
export function ingestMessageToFirebotChatMessage(
    ingest: YouTubeIngestMessage,
    options: { selfDisplayName?: string } = {}
): FirebotChatMessage | null {
    if (ingest == null || ingest.kind !== "text" || typeof ingest.text !== "string") {
        return null;
    }

    const displayName = ingest.author.displayName;
    const text = ingest.text;
    const roles: string[] = [];
    if (ingest.author.isOwner) {
        roles.push("broadcaster");
    }
    if (ingest.author.isModerator) {
        roles.push("mod");
    }
    if (ingest.author.isSponsor) {
        roles.push("sub");
    }

    const selfName = options.selfDisplayName?.toLowerCase();
    const tagged = rolesTextHasMention(text, selfName);

    return {
        id: ingest.messageId,
        platform: "youtube",
        username: displayName.toLowerCase(),
        userId: ingest.author.channelId, // RAW platform id — WS invariant #1
        userDisplayName: displayName,
        profilePicUrl: ingest.author.avatarUrl,
        roles,
        badges: [
            ...(ingest.author.isOwner ? [{ title: "broadcaster", url: "" }] : []),
            ...(ingest.author.isModerator ? [{ title: "mod", url: "" }] : []),
            ...(ingest.author.isSponsor ? [{ title: "subscriber", url: "" }] : [])
        ],
        rawText: text,
        parts: buildParts(text),
        whisper: false,
        action: false,
        tagged,
        isBroadcaster: ingest.author.isOwner,
        isMod: ingest.author.isModerator,
        isSubscriber: ingest.author.isSponsor,
        isSharedChatMessage: false
    };
}
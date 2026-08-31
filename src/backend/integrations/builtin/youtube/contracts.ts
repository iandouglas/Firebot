import { EventEmitter } from "events";

import type { AuthDetails } from "../../../../types";

/**
 * WS-1 shared contracts for the YouTube integration. Every other YouTube workstream
 * (WS-2/4/5/6/8/9) imports from here instead of from each other.
 */

export type YouTubePlatform = "youtube";

/** Which Firebot-side account an action runs against. */
export type YouTubeAccountType = "streamer" | "bot";

/** Channel info from `channels.list?part=snippet&mine=true`. */
export interface YouTubeChannelInfo {
    /** Raw platform id (UC...) */
    channelId: string;
    channelTitle: string;
    avatarUrl: string;
}

/** A linked YouTube account as stored/passed around in Firebot. */
export interface YouTubeAccountContext {
    /** "youtube:streamer-account" | "youtube:bot-account" */
    providerId: string;
    channel: YouTubeChannelInfo;
    auth: AuthDetails;
}

export type YouTubeIngestMessageKind =
    | "text"
    | "member-join"
    | "member-milestone"
    | "gift-membership"
    | "gift-membership-received"
    | "super-chat"
    | "super-sticker"
    | "banned";

/** Per-message author details (from `authorDetails`, no extra API call needed). */
export interface YouTubeIngestMessageAuthor {
    channelId: string;
    displayName: string;
    avatarUrl: string;
    isOwner: boolean;
    isModerator: boolean;
    isSponsor: boolean;
}

/** Kind-specific extras for monetization / moderation messages. */
export interface YouTubeIngestMessagePayload {
    superChatAmountDisplay?: string;
    superChatAmountMicros?: string;
    superChatCurrency?: string;
    superChatTier?: number;
    memberLevelName?: string;
    memberMonth?: number;
    isUpgrade?: boolean;
    giftCount?: number;
    gifterChannelId?: string;
}

/**
 * Every YT message (chat or event) is normalized to this shape before it
 * reaches Firebot core (WS-4 ingest).
 */
export interface YouTubeIngestMessage {
    kind: YouTubeIngestMessageKind;
    messageId: string;
    author: YouTubeIngestMessageAuthor;
    text?: string;
    /** ISO timestamp */
    publishedAt: string;
    payload?: YouTubeIngestMessagePayload;
}

/** Error taxonomy shared by all YouTube workstreams. */
export type YouTubeApiErrorKind = "quota" | "rate-limit" | "chat-ended" | "auth" | "not-found" | "other";

interface YouTubeApiErrorOptions {
    httpStatus?: number;
    reason?: string;
    account?: YouTubeAccountType;
}

export class YouTubeApiError extends Error {
    readonly kind: YouTubeApiErrorKind;
    readonly httpStatus?: number;
    readonly reason?: string;
    readonly account?: YouTubeAccountType;

    constructor(kind: YouTubeApiErrorKind, message: string, options: YouTubeApiErrorOptions = {}) {
        super(message);
        this.name = "YouTubeApiError";
        this.kind = kind;
        this.httpStatus = options.httpStatus;
        this.reason = options.reason;
        this.account = options.account;
    }
}

/**
 * Cross-workstream event bus for the YouTube integration.
 *
 * - "chat-message" (message: YouTubeIngestMessage) — WS-4
 * - "stream-online" (videoId, liveChatId, concurrentViewers?, startedAt?) — WS-2
 * - "stream-offline" () — WS-2
 * - "account-linked" (account: YouTubeAccountContext) — WS-1
 *
 * WS-2/4/5/6/8/9 subscribe to this — never import each other directly.
 */
export const youtubeChatEvents = new EventEmitter();
// WS-2/4/5/6/7/8/9 plus core listeners can accumulate; raise the ceiling to avoid warnings.
youtubeChatEvents.setMaxListeners(30);

/** A broadcast from `liveBroadcasts.list?mine=true&part=snippet,status,contentDetails`. */
export interface YouTubeBroadcast {
    id: string;
    title: string;
    liveChatId?: string;
    /** "live" | "testStarting" | "complete" | "ready" | "created" | ... */
    lifeCycleStatus?: string;
    privacyStatus?: string;
    recordingStatus?: string;
    scheduledStartTime?: string;
    actualStartTime?: string;
    actualEndTime?: string;
}

/** Live specifics for a video id (`videos.list?part=liveStreamingDetails,statistics`). */
export interface YouTubeVideoLiveDetails {
    videoId: string;
    liveChatId?: string;
    concurrentViewers?: string;
    totalLikeCount?: string;
    totalViewCount?: string;
    actualStartTime?: string;
}

export interface YouTubeChatAuthor {
    channelId: string;
    displayName: string;
    avatarUrl: string;
    isVerified: boolean;
    isChatOwner: boolean;
    isChatModerator: boolean;
    isChatSponsor: boolean;
}

/**
 * One chat item from `liveChatMessages.list` (id + snippet + authorDetails).
 * `details` carries the raw `snippet` so WS-4 can pull kind-specific
 * monetization payloads (superChatDetails, memberMilestoneChatDetails, etc.).
 */
export interface YouTubeChatMessageItem {
    id: string;
    /** snippet.type: "textMessageEvent" | "superChatEvent" | "newSponsorEvent" | ... */
    type: string;
    publishedAt: string;
    displayMessage: string;
    authorChannelId: string;
    author: YouTubeChatAuthor;
    details?: Record<string, unknown>;
}

export interface YouTubeChatMessageList {
    liveChatId: string;
    messages: YouTubeChatMessageItem[];
    /** Persist per session only (memory) — see core invariant #6. */
    nextPageToken?: string;
    /** Wait this long (ms) before the next poll. */
    pollingIntervalMillis: number;
    /** Present when the chat has ended. */
    offlineAt?: string;
}

export interface YouTubeMember {
    channelId: string;
    displayName: string;
    avatarUrl: string;
    highestAccessibleLevel?: string;
    highestAccessibleLevelDisplayName?: string;
}

export interface YouTubeMembershipLevel {
    id: string;
    level: number;
    displayName: string;
}

export type YouTubeBanType = "temporary" | "permanent";
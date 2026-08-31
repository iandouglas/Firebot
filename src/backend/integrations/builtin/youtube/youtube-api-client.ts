import {
    YouTubeApiError,
    type YouTubeAccountType,
    type YouTubeBanType,
    type YouTubeBroadcast,
    type YouTubeChannelInfo,
    type YouTubeChatAuthor,
    type YouTubeChatMessageItem,
    type YouTubeChatMessageList,
    type YouTubeMember,
    type YouTubeMembershipLevel,
    type YouTubeVideoLiveDetails,
    type YouTubeApiErrorKind
} from "./contracts";

import { youtubeAccountStore } from "./account-store";

const YT_API_BASE = "https://www.googleapis.com/youtube/v3";

interface RequestOptions {
    query?: Record<string, string | undefined>;
    body?: unknown;
}

interface GoogleApiErrorResponse {
    error?: {
        code?: number;
        message?: string;
        status?: string;
        errors?: Array<{ reason?: string; message?: string }>;
        details?: Array<{ reason?: string; '@type'?: string; message?: string }>;
    };
}

interface ChannelsListResponse {
    items?: Array<{
        id?: string;
        snippet?: {
            title?: string;
            thumbnails?: {
                default?: { url?: string };
                medium?: { url?: string };
                high?: { url?: string };
            };
        };
    }>;
}

interface BroadcastsListResponse {
    items?: Array<{
        id?: string;
        snippet?: {
            title?: string;
            liveChatId?: string;
            scheduledStartTime?: string;
            actualStartTime?: string;
            actualEndTime?: string;
        };
        status?: {
            lifeCycleStatus?: string;
            privacyStatus?: string;
            recordingStatus?: string;
        };
    }>;
}

interface VideosListResponse {
    items?: Array<{
        id?: string;
        liveStreamingDetails?: {
            chatId?: string;
            concurrentViewers?: string;
            actualStartTime?: string;
        };
        statistics?: {
            viewCount?: string;
            likeCount?: string;
        };
    }>;
}

interface LiveChatMessagesListResponse {
    items?: Array<{
        id?: string;
        snippet?: {
            type?: string;
            liveChatId?: string;
            authorChannelId?: string;
            publishedAt?: string;
            displayMessage?: string;
        };
        authorDetails?: {
            channelId?: string;
            displayName?: string;
            profileImageUrl?: string;
            isVerified?: boolean;
            isChatOwner?: boolean;
            isChatModerator?: boolean;
            isChatSponsor?: boolean;
        };
    }>;
    nextPageToken?: string;
    pollingIntervalMillis?: number;
    offlineAt?: string;
}

interface LiveChatMessagesInsertResponse {
    id?: string;
}

interface MembersListResponse {
    items?: Array<{
        snippet?: {
            channelId?: string;
            memberDetails?: {
                channelId?: string;
                displayName?: string;
                profilePictureUrl?: string;
            };
            membershipsDetails?: {
                highestAccessibleLevel?: string;
                highestAccessibleLevelDisplayName?: string;
            };
        };
    }>;
    nextPageToken?: string;
}

interface MembershipLevelsListResponse {
    items?: Array<{
        id?: string;
        snippet?: {
            levelDetails?: {
                level?: number;
                displayName?: string;
            };
        };
    }>;
}

function mapBroadcast(item: NonNullable<BroadcastsListResponse["items"]>[number]): YouTubeBroadcast {
    return {
        id: item.id ?? "",
        title: item.snippet?.title ?? "",
        liveChatId: item.snippet?.liveChatId,
        lifeCycleStatus: item.status?.lifeCycleStatus,
        privacyStatus: item.status?.privacyStatus,
        recordingStatus: item.status?.recordingStatus,
        scheduledStartTime: item.snippet?.scheduledStartTime,
        actualStartTime: item.snippet?.actualStartTime,
        actualEndTime: item.snippet?.actualEndTime
    };
}

function mapChatAuthor(item: NonNullable<LiveChatMessagesListResponse["items"]>[number]): YouTubeChatAuthor {
    const authorDetails = item.authorDetails ?? {};
    return {
        channelId: authorDetails.channelId ?? "",
        displayName: authorDetails.displayName ?? "",
        avatarUrl: authorDetails.profileImageUrl ?? "",
        isVerified: authorDetails.isVerified === true,
        isChatOwner: authorDetails.isChatOwner === true,
        isChatModerator: authorDetails.isChatModerator === true,
        isChatSponsor: authorDetails.isChatSponsor === true
    };
}

function mapChatMessageItem(item: NonNullable<LiveChatMessagesListResponse["items"]>[number]): YouTubeChatMessageItem {
    const snippet = item.snippet ?? {};
    return {
        id: item.id ?? "",
        type: snippet.type ?? "",
        publishedAt: snippet.publishedAt ?? "",
        displayMessage: snippet.displayMessage ?? "",
        authorChannelId: snippet.authorChannelId ?? "",
        author: mapChatAuthor(item),
        details: snippet as Record<string, unknown>
    };
}

function mapMember(item: NonNullable<MembersListResponse["items"]>[number]): YouTubeMember | null {
    const channelId = item.snippet?.memberDetails?.channelId ?? item.snippet?.channelId;
    if (channelId == null) {
        return null;
    }
    return {
        channelId,
        displayName: item.snippet?.memberDetails?.displayName ?? "",
        avatarUrl: item.snippet?.memberDetails?.profilePictureUrl ?? "",
        highestAccessibleLevel: item.snippet?.membershipsDetails?.highestAccessibleLevel,
        highestAccessibleLevelDisplayName: item.snippet?.membershipsDetails?.highestAccessibleLevelDisplayName
    };
}

function extractErrorInfo(status: number, body: unknown): {
    kind: YouTubeApiErrorKind;
    reason?: string;
    message?: string;
} {
    if (body == null || typeof body !== "object") {
        return { kind: "other", message: `YouTube API request failed with status ${status}` };
    }

    const error = (body as GoogleApiErrorResponse).error ?? {};
    const reason = error.errors?.find(entry => entry.reason)?.reason
        ?? error.details?.find(entry => entry.reason)?.reason;

    let kind: YouTubeApiErrorKind = "other";

    if (status === 401) {
        kind = "auth";
    } else if (status === 403) {
        if (reason === "quotaExceeded" || reason === "dailyLimitExceeded" || error.status === "RESOURCE_EXHAUSTED") {
            kind = "quota";
        } else if (
            reason === "rateLimitExceeded"
            || reason === "userRateLimitExceeded"
            || reason === "rpmRateExceeded"
            || reason === "uploadRateLimitExceeded"
            || reason === "activityLimitReached"
        ) {
            kind = "rate-limit";
        } else if (reason === "liveChatEnded") {
            kind = "chat-ended";
        }
    } else if (status === 404 || reason === "liveChatNotFound") {
        kind = "not-found";
    }

    const message = error.message ?? error.errors?.find(entry => entry.message)?.message;

    return { kind, reason, message };
}

function mapHttpError(
    account: YouTubeAccountType,
    method: string,
    urlPath: string,
    status: number,
    body: unknown
): YouTubeApiError {
    const { kind, reason, message } = extractErrorInfo(status, body);
    const label = message ?? `YouTube API request failed with status ${status}`;
    return new YouTubeApiError(kind, `${method} ${urlPath} failed: ${label}`, {
        httpStatus: status,
        reason,
        account
    });
}

/**
 * Single REST façade over the YouTube Data API v3 (no SDK, plain fetch).
 *
 * Every method takes an explicit account ("streamer" | "bot"); token resolution
 * + refresh happens inside via the account-store. All HTTP failures are mapped
 * onto the YouTubeApiError taxonomy (kind: auth | quota | rate-limit |
 * chat-ended | not-found | other).
 */
class YouTubeApiClient {
    async getMyChannel(account: YouTubeAccountType): Promise<YouTubeChannelInfo> {
        const response = await this._request<ChannelsListResponse>(account, "GET", "/channels", {
            query: { part: "snippet", mine: "true" }
        });

        const channel = response.items?.[0];
        if (channel?.id == null) {
            throw new YouTubeApiError("not-found", "YouTube channel not found for the authenticated account", {
                account
            });
        }

        return {
            channelId: channel.id,
            channelTitle: channel.snippet?.title ?? "",
            avatarUrl:
                channel.snippet?.thumbnails?.high?.url
                ?? channel.snippet?.thumbnails?.medium?.url
                ?? channel.snippet?.thumbnails?.default?.url
                ?? ""
        };
    }

    async listOwnBroadcasts(account: YouTubeAccountType): Promise<YouTubeBroadcast[]> {
        const response = await this._request<BroadcastsListResponse>(account, "GET", "/liveBroadcasts", {
            query: {
                part: "snippet,status,contentDetails",
                mine: "true",
                maxResults: "50"
            }
        });

        return (response.items ?? []).map(mapBroadcast);
    }

    async updateBroadcastTitle(account: YouTubeAccountType, videoId: string, title: string): Promise<YouTubeBroadcast> {
        const response = await this._request<NonNullable<BroadcastsListResponse["items"]>[number]>(
            account,
            "PUT",
            "/liveBroadcasts",
            {
                query: { part: "snippet" },
                body: {
                    id: videoId,
                    snippet: { title }
                }
            }
        );

        return mapBroadcast(response ?? {});
    }

    async getVideoLiveDetails(account: YouTubeAccountType, videoId: string): Promise<YouTubeVideoLiveDetails | null> {
        const response = await this._request<VideosListResponse>(account, "GET", "/videos", {
            query: {
                part: "liveStreamingDetails,statistics",
                id: videoId
            }
        });

        const video = response.items?.[0];
        if (video == null) {
            return null;
        }

        return {
            videoId: video.id ?? videoId,
            liveChatId: video.liveStreamingDetails?.chatId,
            concurrentViewers: video.liveStreamingDetails?.concurrentViewers,
            totalLikeCount: video.statistics?.likeCount,
            totalViewCount: video.statistics?.viewCount,
            actualStartTime: video.liveStreamingDetails?.actualStartTime
        };
    }

    async listChatMessages(account: YouTubeAccountType, liveChatId: string, pageToken?: string): Promise<YouTubeChatMessageList> {
        const response = await this._request<LiveChatMessagesListResponse>(account, "GET", "/liveChatMessages", {
            query: {
                liveChatId,
                part: "id,snippet,authorDetails",
                maxResults: "200",
                pageToken
            }
        });

        return {
            liveChatId,
            messages: (response.items ?? []).map(mapChatMessageItem),
            nextPageToken: response.nextPageToken,
            pollingIntervalMillis: response.pollingIntervalMillis ?? 10000,
            offlineAt: response.offlineAt
        };
    }

    async insertChatMessage(account: YouTubeAccountType, liveChatId: string, text: string): Promise<{ id: string }> {
        const response = await this._request<LiveChatMessagesInsertResponse>(account, "POST", "/liveChatMessages", {
            query: { part: "id,snippet" },
            body: {
                snippet: {
                    liveChatId,
                    type: "textMessageEvent",
                    textMessageDetails: {
                        messageText: text
                    }
                }
            }
        });

        return { id: response.id ?? "" };
    }

    async deleteChatMessage(account: YouTubeAccountType, messageId: string): Promise<void> {
        await this._request<unknown>(account, "DELETE", "/liveChatMessages", {
            query: { id: messageId }
        });
    }

    async banUser(
        account: YouTubeAccountType,
        liveChatId: string,
        channelId: string,
        ban: { type: YouTubeBanType; durationSecs?: number }
    ): Promise<string | null> {
        const snippet: Record<string, unknown> = {
            liveChatId,
            type: ban.type,
            bannedUserDetails: {
                channelId
            }
        };

        // API constraint: temporary bans must be between 30s and 86399s.
        if (ban.type === "temporary" && ban.durationSecs != null) {
            snippet.banDurationSeconds = Math.min(Math.max(Math.round(ban.durationSecs), 30), 86399);
        }

        const response = await this._request<{ id?: string }>(account, "POST", "/liveChatBans", {
            query: { part: "snippet" },
            body: { snippet }
        });

        // The created liveChatBan resource carries the id needed to lift the
        // ban later (the API has no "unban by channel" endpoint).
        return response?.id ?? null;
    }

    async unbanUser(account: YouTubeAccountType, bannedChatId: string): Promise<void> {
        await this._request<unknown>(account, "DELETE", "/liveChatBans", {
            query: { id: bannedChatId }
        });
    }

    async listMembers(account: YouTubeAccountType): Promise<{ members: YouTubeMember[]; nextPageToken?: string }> {
        const response = await this._request<MembersListResponse>(account, "GET", "/members", {
            query: {
                part: "snippet",
                maxResults: "500"
            }
        });

        return {
            members: (response.items ?? [])
                .map(mapMember)
                .filter((member): member is YouTubeMember => member != null),
            nextPageToken: response.nextPageToken
        };
    }

    async listMembershipLevels(account: YouTubeAccountType): Promise<YouTubeMembershipLevel[]> {
        const response = await this._request<MembershipLevelsListResponse>(account, "GET", "/membershipsLevels", {
            query: { part: "snippet" }
        });

        return (response.items ?? []).map(item => ({
            id: item.id ?? "",
            level: item.snippet?.levelDetails?.level ?? 0,
            displayName: item.snippet?.levelDetails?.displayName ?? ""
        }));
    }

    private async _request<TResult>(
        account: YouTubeAccountType,
        method: "GET" | "POST" | "PUT" | "DELETE",
        urlPath: string,
        options: RequestOptions = {}
    ): Promise<TResult> {
        const accessToken = await youtubeAccountStore.getFreshAccessToken(account);
        if (accessToken == null) {
            throw new YouTubeApiError("auth", `No authenticated YouTube '${account}' token available`, { account });
        }

        const url = new URL(`${YT_API_BASE}${urlPath}`);
        for (const [key, value] of Object.entries(options.query ?? {})) {
            if (value != null) {
                url.searchParams.set(key, value);
            }
        }

        const headers: Record<string, string> = {
            "Authorization": `Bearer ${accessToken}`,
            "Accept": "application/json"
        };
        if (options.body != null) {
            headers["Content-Type"] = "application/json";
        }

        let response: Response;
        try {
            response = await fetch(url, {
                method,
                headers,
                ...(options.body != null ? { body: JSON.stringify(options.body) } : {})
            });
        } catch (error) {
            throw new YouTubeApiError("other", `${method} ${urlPath} failed: network error`, {
                account,
                ...(error instanceof Error ? { reason: error.message } : {})
            });
        }

        if (response.status >= 200 && response.status < 300) {
            if (response.status === 204) {
                return {} as TResult;
            }
            try {
                return await response.json() as TResult;
            } catch {
                return {} as TResult;
            }
        }

        let errorBody: unknown = null;
        try {
            errorBody = await response.json();
        } catch {
            errorBody = null;
        }

        throw mapHttpError(account, method, urlPath, response.status, errorBody);
    }
}

export const youTubeApiClient = new YouTubeApiClient();
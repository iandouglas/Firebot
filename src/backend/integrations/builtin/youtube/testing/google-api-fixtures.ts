/**
 * Test fixtures shaped like real Google/YouTube API responses.
 * All credentials/tokens are FAKE inline values — never real secrets.
 */

import type { AuthDetails } from "../../../../../types";
import type { YouTubeAccountType } from "../contracts";

// Timestamps must be relative to the real clock: refresh logic compares against Date.now().
const NOW = Date.now();

export const FAKE_NOW = NOW;

export function fakeAuthDetails(account: YouTubeAccountType, expiresIn = 3600): AuthDetails {
    return {
        access_token: account === "streamer" ? "fake-streamer-access-token" : "fake-bot-access-token",
        token_type: "Bearer",
        scope: [
            "https://www.googleapis.com/auth/youtube.force-ssl",
            ...(account === "streamer" ? ["https://www.googleapis.com/auth/youtube.channel-memberships.creator"] : [])
        ],
        obtainment_timestamp: NOW - 60 * 1000,
        expires_in: expiresIn,
        refresh_token: account === "streamer" ? "fake-streamer-refresh-token" : "fake-bot-refresh-token"
    };
}

export function expiredAuthDetails(account: YouTubeAccountType): AuthDetails {
    return {
        ...fakeAuthDetails(account),
        obtainment_timestamp: NOW - 2 * 24 * 60 * 60 * 1000, // obtained 2 days ago
        expires_in: 3600 // expired long ago
    };
}

export const googleCredentialFixtures = {
    googleClientId: "fake-google-client-id.apps.googleusercontent.com",
    googleClientSecret: "fake-google-client-secret"
};

/** channels.list?part=snippet&mine=true */
export const channelsListFixture = {
    kind: "youtube#channelListResponse",
    etag: "fake-etag-channels",
    pageInfo: {
        totalResults: 1,
        resultsPerPage: 1
    },
    items: [
        {
            kind: "youtube#channel",
            etag: "fake-etag-channel-1",
            id: "UCfakeStreamerChannelId123",
            snippet: {
                title: "Fake Firebot Streamer",
                description: "A fake channel for tests",
                publishedAt: "2019-05-01T00:00:00Z",
                thumbnails: {
                    default: { url: "https://example.test/streamer-avatar-88.jpg", width: 88, height: 88 },
                    medium: { url: "https://example.test/streamer-avatar-240.jpg", width: 240, height: 240 },
                    high: { url: "https://example.test/streamer-avatar-800.jpg", width: 800, height: 800 }
                }
            }
        }
    ]
};

export const botChannelsListFixture = {
    kind: "youtube#channelListResponse",
    etag: "fake-etag-channels",
    items: [
        {
            kind: "youtube#channel",
            etag: "fake-etag-bot-channel",
            id: "UCfakeBotChannelId456",
            snippet: {
                title: "Fake Firebot Bot",
                thumbnails: {
                    default: { url: "https://example.test/bot-avatar-88.jpg" }
                }
            }
        }
    ]
};

/** liveBroadcasts.list?mine=true&part=snippet,status,contentDetails */
export const broadcastsListFixture = {
    kind: "youtube#liveBroadcastListResponse",
    pageInfo: { totalResults: 1, resultsPerPage: 5 },
    items: [
        {
            kind: "youtube#liveBroadcast",
            id: "fakeVideoIdBroadcast1",
            snippet: {
                publishedAt: "2025-10-01T18:00:00Z",
                title: "Fake Stream Title",
                description: "A fake live broadcast",
                liveChatId: "Cg0KC0Zha2VDaGF0SWT4AyAB"
            },
            status: {
                lifeCycleStatus: "live",
                privacyStatus: "public",
                recordingStatus: "recording"
            },
            contentDetails: {
                enableAutoStart: true,
                enableAutoStop: false
            }
        }
    ]
};

/** videos.list?part=liveStreamingDetails,statistics&id=... */
export const videosListFixture = {
    kind: "youtube#videoListResponse",
    items: [
        {
            kind: "youtube#video",
            id: "fakeVideoIdBroadcast1",
            liveStreamingDetails: {
                actualStartTime: "2025-10-01T18:05:00Z",
                concurrentViewers: "1337",
                chatId: "Cg0KC3ZpZGVvQ2hhdElE"
            },
            statistics: {
                viewCount: "5678",
                likeCount: "432"
            }
        }
    ]
};

function chatAuthorFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        kind: "youtube#chatMessageAuthorDetails",
        channelId: "UCfakeAuthorChannelId",
        displayName: "FakeViewer123",
        profileImageUrl: "https://example.test/viewer-avatar.jpg",
        isVerified: false,
        isChatOwner: false,
        isChatModerator: false,
        isChatSponsor: false,
        ...overrides
    };
}

/** liveChatMessages.list?liveChatId=...&part=id,snippet,authorDetails&maxResults=200 */
export const chatMessagesListFixture = {
    kind: "youtube#liveChatMessageListResponse",
    nextPageToken: "fake-next-page-token",
    pollingIntervalMillis: 5000,
    items: [
        {
            kind: "youtube#liveChatMessage",
            id: "fakeChatMessage1",
            snippet: {
                type: "textMessageEvent",
                liveChatId: "Cg0KC3ZpZGVvQ2hhdElE",
                authorChannelId: "UCfakeAuthorChannelId",
                publishedAt: "2025-10-01T18:10:00.123Z",
                hasDisplayContent: true,
                displayMessage: "Hello from a fake viewer!",
                textMessageDetails: {
                    messageText: "Hello from a fake viewer!"
                }
            },
            authorDetails: chatAuthorFixture()
        },
        {
            kind: "youtube#liveChatMessage",
            id: "fakeSuperChat1",
            snippet: {
                type: "superChatEvent",
                liveChatId: "Cg0KC3ZpZGVvQ2hhdElE",
                authorChannelId: "UCfakeAuthorChannelId",
                publishedAt: "2025-10-01T18:11:00Z",
                hasDisplayContent: true,
                displayMessage: "Great stream!",
                superChatDetails: {
                    amountDisplayString: "$5.00",
                    amountMicros: "5000000",
                    currency: "USD",
                    amountChattedMicros: "0",
                    tier: 2
                }
            },
            authorDetails: chatAuthorFixture({ isChatSponsor: true })
        }
    ]
};

export const chatMessagesEndedFixture = {
    kind: "youtube#liveChatMessageListResponse",
    pollingIntervalMillis: 5000,
    offlineAt: "2025-10-01T20:00:00Z",
    items: []
};

/** liveChatMessages.insert response */
export const chatMessageInsertFixture = {
    kind: "youtube#liveChatMessage",
    id: "fakeInsertedMessageId",
    snippet: {
        type: "textMessageEvent",
        liveChatId: "Cg0KC3ZpZGVvQ2hhdElE",
        authorChannelId: "UCfakeBotChannelId456",
        publishedAt: "2025-10-01T18:12:00Z",
        displayMessage: "Fake bot says hi",
        textMessageDetails: { messageText: "Fake bot says hi" }
    }
};

/** liveChatBans.insert response */
export const chatBanInsertFixture = {
    kind: "youtube#liveChatBan",
    id: "fakeBanResourceId",
    snippet: {
        type: "temporary",
        liveChatId: "Cg0KC3ZpZGVvQ2hhdElE",
        bannedUserDetails: { channelId: "UCfakeAuthorChannelId" },
        banDurationSeconds: 600
    }
};

/** members.list?part=snippet */
export const membersListFixture = {
    kind: "youtube#memberListResponse",
    items: [
        {
            kind: "youtube#member",
            etag: "fake-etag-member-1",
            snippet: {
                channelId: "UCfakeAuthorChannelId",
                memberDetails: {
                    channelId: "UCfakeAuthorChannelId",
                    displayName: "FakeViewer123",
                    profilePictureUrl: "https://example.test/viewer-avatar.jpg"
                },
                membershipsDetails: {
                    highestAccessibleLevel: "member",
                    highestAccessibleLevelDisplayName: "Member (1 year)"
                }
            }
        }
    ]
};

/** membershipsLevels.list?part=snippet */
export const membershipLevelsFixture = {
    kind: "youtube#membershipsLevelListResponse",
    items: [
        {
            kind: "youtube#membershipsLevel",
            etag: "fake-etag-level-1",
            id: "fakeLevelId1",
            snippet: {
                levelDetails: {
                    level: 1,
                    displayName: "Member"
                }
            }
        }
    ]
};

/** Standard Google API error envelope. */
export function googleErrorFixture(status: number, reason: string, message: string): unknown {
    return {
        error: {
            code: status,
            message,
            errors: [
                {
                    message,
                    domain: "youtube.live",
                    reason,
                    locationType: "parameter",
                    location: "liveChatId"
                }
            ]
        }
    };
}

export const errorFixtures = {
    authError401: googleErrorFixture(401, "authError", "Invalid Credentials"),
    quotaError403: googleErrorFixture(403, "quotaExceeded", "The request cannot be completed because you have exceeded your quota."),
    rateLimitError403: googleErrorFixture(403, "rateLimitExceeded", "The user has sent too many requests."),
    chatEnded403: {
        error: {
            code: 403,
            message: "The live chat that you are attempting to retrieve is no longer available.",
            errors: [
                {
                    message: "The live chat has ended.",
                    reason: "liveChatEnded"
                }
            ]
        }
    },
    forbidden403: googleErrorFixture(403, "forbidden", "Access forbidden."),
    liveChatNotFound404: googleErrorFixture(404, "liveChatNotFound", "The live chat that you are trying to retrieve cannot be found."),
    videoNotFound404: googleErrorFixture(404, "videoNotFound", "The video that you are trying to update cannot be found."),
    serverError500: googleErrorFixture(500, "internalError", "Internal server error")
};

/** HTTP response helper for fetch mocks. */
export function fetchResponse(status: number, body?: unknown): Response {
    if (body === undefined) {
        return new Response(undefined, { status });
    }
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}
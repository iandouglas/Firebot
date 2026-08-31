import { youtubeAccountStore } from "../account-store";
import { youTubeApiClient } from "../youtube-api-client";
import { YouTubeApiError } from "../contracts";
import {
    broadcastsListFixture,
    channelsListFixture,
    chatBanInsertFixture,
    chatMessageInsertFixture,
    chatMessagesEndedFixture,
    chatMessagesListFixture,
    errorFixtures,
    fetchResponse,
    membersListFixture,
    membershipLevelsFixture,
    videosListFixture
} from "../testing/google-api-fixtures";

jest.mock("../account-store", () => ({
    youtubeAccountStore: {
        getFreshAccessToken: jest.fn()
    }
}));

const mockedStore = youtubeAccountStore as unknown as { getFreshAccessToken: jest.Mock };
const mockedFetch = jest.fn();

beforeEach(() => {
    mockedStore.getFreshAccessToken.mockReset();
    mockedFetch.mockReset();
    globalThis.fetch = mockedFetch as unknown as typeof fetch;
});

afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
});

function givenToken(account: "streamer" | "bot", token: string | null): void {
    mockedStore.getFreshAccessToken.mockImplementation(async requested => {
        expect(requested).toBe(account);
        return token;
    });
}

function lastRequest(): { url: URL; init: RequestInit } {
    expect(mockedFetch).toHaveBeenCalled();
    const [url, init] = mockedFetch.mock.calls[mockedFetch.mock.calls.length - 1] as [URL, RequestInit];
    return { url: new URL(url.toString()), init };
}

describe("YouTube api client", () => {
    describe("token injection per account", () => {
        it("sends the streamer token for account='streamer'", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(200, channelsListFixture));

            await youTubeApiClient.getMyChannel("streamer");

            expect(lastRequest().init.headers).toMatchObject({
                Authorization: "Bearer fake-streamer-access-token"
            });
            expect(lastRequest().url.searchParams.get("mine")).toBe("true");
        });

        it("sends the bot token for account='bot'", async () => {
            givenToken("bot", "fake-bot-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(200, channelsListFixture));

            await youTubeApiClient.getMyChannel("bot");

            expect(lastRequest().init.headers).toMatchObject({
                Authorization: "Bearer fake-bot-access-token"
            });
        });

        it("throws kind 'auth' without any network call when no token is available", async () => {
            givenToken("streamer", null);

            await expect(youTubeApiClient.getMyChannel("streamer")).rejects.toMatchObject({
                kind: "auth",
                name: "YouTubeApiError"
            });
            expect(mockedFetch).not.toHaveBeenCalled();
        });
    });

    describe("getMyChannel", () => {
        it("maps the channels.list fixture", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(200, channelsListFixture));

            const channel = await youTubeApiClient.getMyChannel("streamer");

            expect(channel).toEqual({
                channelId: "UCfakeStreamerChannelId123",
                channelTitle: "Fake Firebot Streamer",
                avatarUrl: "https://example.test/streamer-avatar-800.jpg"
            });
            expect(lastRequest().url.searchParams.get("part")).toBe("snippet");
        });

        it("throws kind 'not-found' when the response has no channel", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(200, { items: [] }));

            await expect(youTubeApiClient.getMyChannel("streamer")).rejects.toMatchObject({ kind: "not-found" });
        });
    });

    describe("listOwnBroadcasts", () => {
        it("lists own broadcasts with live chat id and lifecycle status", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(200, broadcastsListFixture));

            const broadcasts = await youTubeApiClient.listOwnBroadcasts("streamer");

            expect(broadcasts).toHaveLength(1);
            expect(broadcasts[0]).toMatchObject({
                id: "fakeVideoIdBroadcast1",
                title: "Fake Stream Title",
                liveChatId: "Cg0KC0Zha2VDaGF0SWT4AyAB",
                lifeCycleStatus: "live"
            });

            const { url } = lastRequest();
            expect(url.pathname).toBe("/youtube/v3/liveBroadcasts");
            expect(url.searchParams.get("mine")).toBe("true");
            expect(url.searchParams.get("part")).toBe("snippet,status,contentDetails");
        });
    });

    describe("updateBroadcastTitle", () => {
        it("sends a liveBroadcasts.update PUT with the new title", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(200, broadcastsListFixture.items[0]));

            await youTubeApiClient.updateBroadcastTitle("streamer", "fakeVideoIdBroadcast1", "New Fake Title");

            const { url, init } = lastRequest();
            expect(init.method).toBe("PUT");
            expect(url.searchParams.get("part")).toBe("snippet");
            expect(JSON.parse(init.body as string)).toEqual({
                id: "fakeVideoIdBroadcast1",
                snippet: { title: "New Fake Title" }
            });
        });
    });

    describe("getVideoLiveDetails", () => {
        it("maps live streaming details + statistics", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(200, videosListFixture));

            const details = await youTubeApiClient.getVideoLiveDetails("streamer", "fakeVideoIdBroadcast1");

            expect(details).toEqual({
                videoId: "fakeVideoIdBroadcast1",
                liveChatId: "Cg0KC3ZpZGVvQ2hhdElE",
                concurrentViewers: "1337",
                totalLikeCount: "432",
                totalViewCount: "5678",
                actualStartTime: "2025-10-01T18:05:00Z"
            });
            expect(lastRequest().url.searchParams.get("id")).toBe("fakeVideoIdBroadcast1");
        });

        it("returns null when the video does not exist", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(200, { items: [] }));

            const details = await youTubeApiClient.getVideoLiveDetails("streamer", "missingVideoId");

            expect(details).toBeNull();
        });
    });

    describe("listChatMessages", () => {
        it("requests 200 messages + pagination and maps the message items", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(200, chatMessagesListFixture));

            const result = await youTubeApiClient.listChatMessages("streamer", "Cg0KC3ZpZGVvQ2hhdElE", "fake-page-token");

            const { url } = lastRequest();
            expect(url.pathname).toBe("/youtube/v3/liveChatMessages");
            expect(url.searchParams.get("liveChatId")).toBe("Cg0KC3ZpZGVvQ2hhdElE");
            expect(url.searchParams.get("part")).toBe("id,snippet,authorDetails");
            expect(url.searchParams.get("maxResults")).toBe("200");
            expect(url.searchParams.get("pageToken")).toBe("fake-page-token");

            expect(result.nextPageToken).toBe("fake-next-page-token");
            expect(result.pollingIntervalMillis).toBe(5000);
            expect(result.messages).toHaveLength(2);
            expect(result.messages[0]).toMatchObject({
                id: "fakeChatMessage1",
                type: "textMessageEvent",
                displayMessage: "Hello from a fake viewer!",
                author: {
                    channelId: "UCfakeAuthorChannelId",
                    isChatSponsor: false
                }
            });
            // Raw snippet is preserved for WS-4 monetization normalization.
            expect(result.messages[1].details).toHaveProperty("superChatDetails.amountDisplayString", "$5.00");
        });

        it("omits pageToken when starting fresh history (invariant #6)", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(200, chatMessagesListFixture));

            await youTubeApiClient.listChatMessages("streamer", "Cg0KC3ZpZGVvQ2hhdElE");

            expect(lastRequest().url.searchParams.has("pageToken")).toBe(false);
        });

        it("surfaces offlineAt when the chat has ended", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(200, chatMessagesEndedFixture));

            const result = await youTubeApiClient.listChatMessages("streamer", "Cg0KC3ZpZGVvQ2hhdElE");

            expect(result.offlineAt).toBe("2025-10-01T20:00:00Z");
            expect(result.messages).toHaveLength(0);
        });
    });

    describe("insertChatMessage", () => {
        it("sends a textMessageEvent insert with the expected request body", async () => {
            givenToken("bot", "fake-bot-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(200, chatMessageInsertFixture));

            const result = await youTubeApiClient.insertChatMessage("bot", "Cg0KC3ZpZGVvQ2hhdElE", "Fake bot says hi");

            expect(result.id).toBe("fakeInsertedMessageId");

            const { url, init } = lastRequest();
            expect(init.method).toBe("POST");
            expect(url.searchParams.get("part")).toBe("id,snippet");
            expect(JSON.parse(init.body as string)).toEqual({
                snippet: {
                    liveChatId: "Cg0KC3ZpZGVvQ2hhdElE",
                    type: "textMessageEvent",
                    textMessageDetails: {
                        messageText: "Fake bot says hi"
                    }
                }
            });
        });

        it("maps a 403 quotaExceeded failure to kind 'quota'", async () => {
            givenToken("bot", "fake-bot-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(403, errorFixtures.quotaError403));

            await expect(youTubeApiClient.insertChatMessage("bot", "liveChatId", "hi")).rejects.toMatchObject({
                kind: "quota",
                httpStatus: 403,
                reason: "quotaExceeded"
            });
        });
    });

    describe("deleteChatMessage", () => {
        it("sends DELETE with the message id", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(204));

            await youTubeApiClient.deleteChatMessage("streamer", "fakeChatMessage1");

            const { url, init } = lastRequest();
            expect(init.method).toBe("DELETE");
            expect(url.searchParams.get("id")).toBe("fakeChatMessage1");
        });
    });

    describe("banUser", () => {
        it("sends a temporary ban with the requested duration", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(200, chatBanInsertFixture));

            await youTubeApiClient.banUser("streamer", "Cg0KC3ZpZGVvQ2hhdElE", "UCfakeRudeViewerId", { type: "temporary", durationSecs: 600 });

            const { url, init } = lastRequest();
            expect(url.searchParams.get("part")).toBe("snippet");
            expect(JSON.parse(init.body as string)).toEqual({
                snippet: {
                    liveChatId: "Cg0KC3ZpZGVvQ2hhdElE",
                    type: "temporary",
                    bannedUserDetails: { channelId: "UCfakeRudeViewerId" },
                    banDurationSeconds: 600
                }
            });
        });

        it("sends a permanent ban without a duration", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(200, chatBanInsertFixture));

            await youTubeApiClient.banUser("streamer", "Cg0KC3ZpZGVvQ2hhdElE", "UCfakeRudeViewerId", { type: "permanent" });

            const body = JSON.parse(lastRequest().init.body as string);
            expect(body.snippet.type).toBe("permanent");
            expect(body.snippet.banDurationSeconds).toBeUndefined();
        });

        it("clamps temporary durations into the 30s-86399s API window", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(200, chatBanInsertFixture));

            await youTubeApiClient.banUser("streamer", "chatId", "channelId", { type: "temporary", durationSecs: 5 });
            expect(JSON.parse(lastRequest().init.body as string).snippet.banDurationSeconds).toBe(30);

            await youTubeApiClient.banUser("streamer", "chatId", "channelId", { type: "temporary", durationSecs: 999999999 });
            expect(JSON.parse(lastRequest().init.body as string).snippet.banDurationSeconds).toBe(86399);
        });
    });

    describe("unbanUser", () => {
        it("sends DELETE with the ban resource id", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(204));

            await youTubeApiClient.unbanUser("streamer", "fakeBanResourceId");

            const { url, init } = lastRequest();
            expect(init.method).toBe("DELETE");
            expect(url.pathname).toBe("/youtube/v3/liveChatBans");
            expect(url.searchParams.get("id")).toBe("fakeBanResourceId");
        });
    });

    describe("listMembers", () => {
        it("maps member fixtures", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(200, membersListFixture));

            const result = await youTubeApiClient.listMembers("streamer");

            expect(result.members).toHaveLength(1);
            expect(result.members[0]).toMatchObject({
                channelId: "UCfakeAuthorChannelId",
                displayName: "FakeViewer123",
                highestAccessibleLevelDisplayName: "Member (1 year)"
            });
            expect(lastRequest().url.searchParams.get("maxResults")).toBe("500");
        });

        it("maps a 403 forbidden (memberships not approved yet) to kind 'other'", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(403, errorFixtures.forbidden403));

            await expect(youTubeApiClient.listMembers("streamer")).rejects.toMatchObject({ kind: "other" });
        });
    });

    describe("listMembershipLevels", () => {
        it("maps membership level fixtures", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(200, membershipLevelsFixture));

            const levels = await youTubeApiClient.listMembershipLevels("streamer");

            expect(levels).toEqual([
                { id: "fakeLevelId1", level: 1, displayName: "Member" }
            ]);
            expect(lastRequest().url.pathname).toBe("/youtube/v3/membershipsLevels");
        });
    });

    describe("error taxonomy mapping", () => {
        it("maps 401 to kind 'auth'", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(401, errorFixtures.authError401));

            await expect(youTubeApiClient.getMyChannel("streamer")).rejects.toMatchObject({
                kind: "auth",
                httpStatus: 401
            });
        });

        it("maps 403 quotaExceeded to kind 'quota'", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(403, errorFixtures.quotaError403));

            await expect(youTubeApiClient.getMyChannel("streamer")).rejects.toMatchObject({ kind: "quota" });
        });

        it("maps 403 rateLimitExceeded to kind 'rate-limit'", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(403, errorFixtures.rateLimitError403));

            await expect(youTubeApiClient.listChatMessages("streamer", "chatId")).rejects.toMatchObject({
                kind: "rate-limit"
            });
        });

        it("maps 403 liveChatEnded to kind 'chat-ended'", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(403, errorFixtures.chatEnded403));

            await expect(youTubeApiClient.listChatMessages("streamer", "chatId")).rejects.toMatchObject({
                kind: "chat-ended",
                reason: "liveChatEnded"
            });
        });

        it("maps 404 to kind 'not-found'", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(404, errorFixtures.liveChatNotFound404));

            await expect(youTubeApiClient.listChatMessages("streamer", "chatId")).rejects.toMatchObject({
                kind: "not-found"
            });

            mockedFetch.mockResolvedValue(fetchResponse(404, errorFixtures.videoNotFound404));
            await expect(youTubeApiClient.getVideoLiveDetails("streamer", "missing")).rejects.toMatchObject({
                kind: "not-found"
            });
        });

        it("maps 500 and raw network failures to kind 'other'", async () => {
            givenToken("streamer", "fake-streamer-access-token");
            mockedFetch.mockResolvedValue(fetchResponse(500, errorFixtures.serverError500));

            await expect(youTubeApiClient.getMyChannel("streamer")).rejects.toMatchObject({ kind: "other" });

            mockedFetch.mockRejectedValue(new Error("ECONNRESET"));
            const error = await youTubeApiClient.getMyChannel("streamer").catch(e => e);
            expect(error).toMatchObject({ kind: "other" });
            expect(error).toBeInstanceOf(YouTubeApiError);
        });
    });
});
/**
 * account-store roundtrip + expiry checks with a mocked auth-manager
 * (no network, no electron).
 */

jest.mock("../../../../auth/auth-manager", () => ({
    __esModule: true,
    default: {
        refreshTokenIfExpired: jest.fn()
    }
}));

jest.mock("../../../../logger-cache", () => ({
    LoggerCache: {
        getLogger: () => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        })
    }
}));

import authManager from "../../../../auth/auth-manager";
import { youtubeAccountStore } from "../account-store";
import type { YouTubeChannelInfo } from "../contracts";
import { STREAMER_ACCOUNT_PROVIDER_ID } from "../youtube-auth";
import { channelsListFixture, expiredAuthDetails, fakeAuthDetails } from "../testing/google-api-fixtures";

const mockedRefreshTokenIfExpired = (authManager.refreshTokenIfExpired as unknown) as jest.Mock;

const streamerChannel: YouTubeChannelInfo = {
    channelId: channelsListFixture.items[0].id,
    channelTitle: channelsListFixture.items[0].snippet.title,
    avatarUrl: channelsListFixture.items[0].snippet.thumbnails.high.url
};

const botChannel: YouTubeChannelInfo = {
    channelId: "UCfakeBotChannelId456",
    channelTitle: "Fake Firebot Bot",
    avatarUrl: "https://example.test/bot-avatar-88.jpg"
};

beforeEach(() => {
    mockedRefreshTokenIfExpired.mockReset();
    youtubeAccountStore.clearAll();
});

describe("YouTube account store", () => {
    describe("roundtrip", () => {
        it("starts empty", () => {
            expect(youtubeAccountStore.getStreamerAccount()).toBeNull();
            expect(youtubeAccountStore.getBotAccount()).toBeNull();
        });

        it("roundtrips a full streamer account context", () => {
            const auth = fakeAuthDetails("streamer");

            youtubeAccountStore.setChannel("streamer", streamerChannel);
            youtubeAccountStore.setAuth("streamer", auth);

            expect(youtubeAccountStore.getStreamerAccount()).toEqual({
                providerId: STREAMER_ACCOUNT_PROVIDER_ID,
                channel: streamerChannel,
                auth
            });
        });

        it("roundtrips a bot account context with its own provider id", () => {
            const auth = fakeAuthDetails("bot");

            youtubeAccountStore.setChannel("bot", botChannel);
            youtubeAccountStore.setAuth("bot", auth);

            expect(youtubeAccountStore.getBotAccount()).toMatchObject({
                providerId: "youtube:bot-account",
                channel: botChannel
            });
        });

        it("returns null until both the auth token AND the channel are known", () => {
            youtubeAccountStore.setAuth("streamer", fakeAuthDetails("streamer"));
            expect(youtubeAccountStore.getStreamerAccount()).toBeNull();

            youtubeAccountStore.setChannel("streamer", streamerChannel);
            expect(youtubeAccountStore.getStreamerAccount()).not.toBeNull();

            youtubeAccountStore.setChannel("streamer", null);
            expect(youtubeAccountStore.getStreamerAccount()).toBeNull();
        });

        it("exposes the raw (channel-less) auth via getRawAccount for token-only paths", () => {
            youtubeAccountStore.setAuth("bot", fakeAuthDetails("bot"));

            expect(youtubeAccountStore.getRawAccount("bot")).toMatchObject({
                providerId: "youtube:bot-account"
            });
            expect(youtubeAccountStore.getRawAccount("streamer")).toBeNull();
        });

        it("clears a single account or everything", () => {
            youtubeAccountStore.setChannel("streamer", streamerChannel);
            youtubeAccountStore.setAuth("streamer", fakeAuthDetails("streamer"));
            youtubeAccountStore.setChannel("bot", botChannel);
            youtubeAccountStore.setAuth("bot", fakeAuthDetails("bot"));

            youtubeAccountStore.clear("streamer");
            expect(youtubeAccountStore.getStreamerAccount()).toBeNull();
            expect(youtubeAccountStore.getBotAccount()).not.toBeNull();

            youtubeAccountStore.clearAll();
            expect(youtubeAccountStore.getBotAccount()).toBeNull();
            expect(youtubeAccountStore.getRawAccount("streamer")).toBeNull();
        });
    });

    describe("token expiry checks", () => {
        it("flags missing/empty auth blobs as expired", () => {
            expect(youtubeAccountStore.isTokenExpired(null)).toBe(true);
            const bare = fakeAuthDetails("streamer");
            delete (bare as { access_token?: string }).access_token;
            expect(youtubeAccountStore.isTokenExpired(bare)).toBe(true);
        });

        it("treats a token with obtainment_timestamp + expires_in runway as valid", () => {
            expect(youtubeAccountStore.isTokenExpired(fakeAuthDetails("streamer", 3600))).toBe(false);
        });

        it("flags tokens that expired (obtainment + expires_in in the past)", () => {
            expect(youtubeAccountStore.isTokenExpired(expiredAuthDetails("streamer"))).toBe(true);
        });

        it("flags tokens inside the five-minute refresh margin as expired", () => {
            const auth = fakeAuthDetails("streamer", 4 * 60); // 4 minutes of runway left
            expect(youtubeAccountStore.isTokenExpired(auth)).toBe(true);
        });

        it("handles expires_at that round-tripped through JSON as an ISO string", () => {
            const auth = fakeAuthDetails("streamer");
            (auth as { expires_at?: unknown }).expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            delete (auth as { expires_in?: number }).expires_in;

            expect(youtubeAccountStore.isTokenExpired(auth)).toBe(false);

            (auth as { expires_at?: unknown }).expires_at = new Date(Date.now() - 1000).toISOString();
            expect(youtubeAccountStore.isTokenExpired(auth)).toBe(true);
        });

        it("treats unknown-expiry tokens as valid (API 401 drives the failure path)", () => {
            const auth = fakeAuthDetails("streamer");
            delete (auth as { expires_in?: number }).expires_in;
            delete (auth as { obtainment_timestamp?: number }).obtainment_timestamp;

            expect(youtubeAccountStore.isTokenExpired(auth)).toBe(false);
        });
    });

    describe("fresh-token resolution", () => {
        it("returns the stored token without contacting auth-manager when fresh", async () => {
            const auth = fakeAuthDetails("streamer");
            youtubeAccountStore.setAuth("streamer", auth);

            await expect(youtubeAccountStore.getFreshAccessToken("streamer")).resolves.toBe(auth.access_token);
            expect(mockedRefreshTokenIfExpired).not.toHaveBeenCalled();
        });

        it("refreshes an expired token via authManager.refreshTokenIfExpired", async () => {
            const originalAuth = expiredAuthDetails("streamer");
            const refreshed = { ...fakeAuthDetails("streamer"), access_token: "fake-refreshed-access-token" };
            mockedRefreshTokenIfExpired.mockResolvedValue(refreshed);

            youtubeAccountStore.setAuth("streamer", originalAuth, { emitUpdate: false });

            await expect(youtubeAccountStore.getFreshAccessToken("streamer")).resolves.toBe("fake-refreshed-access-token");
            expect(mockedRefreshTokenIfExpired).toHaveBeenCalledTimes(1);
            expect(mockedRefreshTokenIfExpired).toHaveBeenCalledWith(STREAMER_ACCOUNT_PROVIDER_ID, originalAuth);

            // The refreshed blob replaces the stored one.
            const stored = youtubeAccountStore.getRawAccount("streamer");
            expect(stored?.auth.access_token).toBe("fake-refreshed-access-token");
        });

        it("returns null when the refresh fails (auth-manager returns null)", async () => {
            mockedRefreshTokenIfExpired.mockResolvedValue(null);

            youtubeAccountStore.setAuth("bot", expiredAuthDetails("bot"));

            await expect(youtubeAccountStore.getFreshAccessToken("bot")).resolves.toBeNull();
            // a failed refresh leaves the old blob in place
            expect(youtubeAccountStore.getRawAccount("bot")?.auth.access_token).toBe("fake-bot-access-token");
        });

        it("returns null when there is no stored auth", async () => {
            await expect(youtubeAccountStore.getFreshAccessToken("bot")).resolves.toBeNull();
            expect(mockedRefreshTokenIfExpired).not.toHaveBeenCalled();
        });
    });

    describe("account-updated events", () => {
        it("emits account-updated on setAuth/setChannel/clear and supports silent updates", () => {
            const listener = jest.fn();
            youtubeAccountStore.on("account-updated", listener);

            youtubeAccountStore.setAuth("streamer", fakeAuthDetails("streamer"));
            expect(listener).toHaveBeenCalledTimes(1);
            const [accountType, firstPayload] = listener.mock.calls[0];
            expect(accountType).toBe("streamer");
            expect(firstPayload.auth.access_token).toBe("fake-streamer-access-token");

            listener.mockClear();
            youtubeAccountStore.setChannel("bot", botChannel, { emitUpdate: false });
            expect(listener).not.toHaveBeenCalled();

            youtubeAccountStore.clear("bot");
            expect(listener).toHaveBeenCalledTimes(1);
        });

        it("clearAll emits one final update per cleared account", () => {
            const listener = jest.fn();
            youtubeAccountStore.on("account-updated", listener);
            youtubeAccountStore.clearAll();

            const types = listener.mock.calls.map(call => call[0]);
            expect(types).toContain("streamer");
            expect(types).toContain("bot");
        });
    });
});
/**
 * WS-8: platform-aware "update-user-banned-status" dispatch — a YouTube context
 * routes to the YouTube moderation module; the Twitch path is preserved
 * byte-for-byte. All collaborators are mocked; no network.
 */

jest.mock("@twurple/api", () => ({
    extractUserId: (id: unknown) => id
}));

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

jest.mock("../src/backend/common/frontend-communicator", () => ({
    __esModule: true,
    default: {
        on: jest.fn(),
        onAsync: jest.fn(),
        send: jest.fn()
    }
}));

jest.mock("../src/backend/chat/frontend-chat-manager", () => ({
    FrontendChatManager: {
        setChatMessageAutomodError: jest.fn()
    }
}));

jest.mock("../src/backend/integrations/builtin/youtube/moderation", () => ({
    youTubeModeration: {
        banUser: jest.fn(),
        unbanUser: jest.fn()
    }
}));

import frontendCommunicator from "../src/backend/common/frontend-communicator";
import { TwitchModerationApi } from "../src/backend/streaming-platforms/twitch/api/resource/moderation";
import { youTubeModeration } from "../src/backend/integrations/builtin/youtube/moderation";

const mockOnAsync = (frontendCommunicator.onAsync as unknown) as jest.Mock;
const mockYtBan = (youTubeModeration.banUser as unknown) as jest.Mock;
const mockYtUnban = (youTubeModeration.unbanUser as unknown) as jest.Mock;

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

const STREAMER_ID = "twitch-streamer-id";
const USER_ID = "twitch-user-id";
const YT_CHANNEL_ID = "UCfakeAuthorChannelId";

let banHandler: (data: unknown) => Promise<unknown>;
let apiBase: {
    streamerClient: { users: { getUserByName: jest.Mock } };
    moderationClient: { moderation: { banUser: jest.Mock; unbanUser: jest.Mock } };
    accounts: { streamer: { userId: string } };
    logger: typeof mockLogger;
};

beforeEach(() => {
    mockYtBan.mockResolvedValue({ success: true });
    mockYtUnban.mockResolvedValue({ success: true });

    mockOnAsync.mockClear();
    mockOnAsync.mockImplementation((eventName: string, callback: unknown) => {
        if (eventName === "update-user-banned-status") {
            banHandler = callback as (data: unknown) => Promise<unknown>;
        }
        return "listener-id";
    });

    apiBase = {
        streamerClient: {
            users: {
                getUserByName: jest.fn().mockResolvedValue({ id: USER_ID })
            }
        },
        moderationClient: {
            moderation: {
                banUser: jest.fn().mockResolvedValue(true),
                unbanUser: jest.fn().mockResolvedValue(true)
            }
        },
        accounts: {
            streamer: { userId: STREAMER_ID }
        },
        logger: mockLogger
    };

    new TwitchModerationApi(apiBase as never);
});

describe("update-user-banned-status platform dispatch", () => {
    it("routes a youtube-context ban to the YouTube moderation module", async () => {
        await banHandler({ username: "SomeViewer", shouldBeBanned: true, platform: "youtube", channelId: YT_CHANNEL_ID });

        expect(mockYtBan).toHaveBeenCalledWith(YT_CHANNEL_ID);
        expect(mockYtUnban).not.toHaveBeenCalled();
        expect(apiBase.moderationClient.moderation.banUser).not.toHaveBeenCalled();
    });

    it("routes a youtube-context unban to the YouTube moderation module", async () => {
        await banHandler({ username: "SomeViewer", shouldBeBanned: false, platform: "youtube", channelId: YT_CHANNEL_ID });

        expect(mockYtUnban).toHaveBeenCalledWith(YT_CHANNEL_ID);
        expect(mockYtBan).not.toHaveBeenCalled();
        expect(apiBase.moderationClient.moderation.unbanUser).not.toHaveBeenCalled();
    });

    it("ignores a youtube context that is missing a channel id", async () => {
        await banHandler({ username: "SomeViewer", shouldBeBanned: true, platform: "youtube" });

        expect(mockYtBan).not.toHaveBeenCalled();
        expect(apiBase.moderationClient.moderation.banUser).not.toHaveBeenCalled();
    });

    it("preserves the exact Twitch ban path when no youtube context is present", async () => {
        await banHandler({ username: "SomeViewer", shouldBeBanned: true });

        expect(apiBase.streamerClient.users.getUserByName).toHaveBeenCalledWith("SomeViewer");
        expect(apiBase.moderationClient.moderation.banUser).toHaveBeenCalledWith(
            STREAMER_ID,
            expect.objectContaining({ user: USER_ID, duration: null, reason: "Banned via Firebot" })
        );
        expect(mockYtBan).not.toHaveBeenCalled();
    });

    it("preserves the exact Twitch unban path when no youtube context is present", async () => {
        await banHandler({ username: "SomeViewer", shouldBeBanned: false });

        expect(apiBase.moderationClient.moderation.unbanUser).toHaveBeenCalledWith(STREAMER_ID, USER_ID);
        expect(mockYtUnban).not.toHaveBeenCalled();
    });

    it("does nothing when the payload is null or missing required fields", async () => {
        await banHandler(null);
        await banHandler({ username: "SomeViewer" });
        await banHandler({ shouldBeBanned: true });

        expect(mockYtBan).not.toHaveBeenCalled();
        expect(apiBase.moderationClient.moderation.banUser).not.toHaveBeenCalled();
    });
});

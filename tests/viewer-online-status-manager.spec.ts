jest.mock("../src/backend/common/settings-manager", () => ({
    SettingsManager: {
        getSetting: jest.fn().mockReturnValue(false)
    }
}));

jest.mock("../src/backend/viewers/viewer-database", () => ({
    __esModule: true,
    default: {
        on: jest.fn(),
        isViewerDBOn: jest.fn().mockReturnValue(true),
        getViewerById: jest.fn(),
        getViewerByUsername: jest.fn(),
        getViewerDb: jest.fn(),
        calculateAutoRanks: jest.fn()
    }
}));

jest.mock("../src/backend/roles/chat-roles-manager", () => ({
    __esModule: true,
    default: {
        userIsKnownBot: jest.fn().mockResolvedValue(false)
    }
}));

jest.mock("../src/backend/common/connection-manager", () => ({
    ConnectionManager: {
        streamerIsOnline: false
    }
}));

jest.mock("../src/backend/events/event-manager", () => ({
    EventManager: {
        triggerEvent: jest.fn()
    }
}));

jest.mock("../src/backend/chat/twitch-chat", () => ({
    __esModule: true,
    default: {
        on: jest.fn()
    }
}));

jest.mock("../src/backend/streaming-platforms/twitch/chatter-poll", () => ({
    __esModule: true,
    default: {
        runChatterPoll: jest.fn()
    }
}));

jest.mock("../src/backend/chat/active-user-handler", () => ({
    ActiveUserHandler: {
        on: jest.fn(),
        getAllOnlineUsers: jest.fn().mockReturnValue([])
    }
}));

jest.mock("../src/backend/logger-cache", () => ({
    LoggerCache: {
        getLogger: jest.fn().mockReturnValue({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn()
        })
    }
}));

import viewerOnlineStatusManager from "../src/backend/viewers/viewer-online-status-manager";
import viewerDatabase from "../src/backend/viewers/viewer-database";
import type { FirebotViewer } from "../src/types";

const getViewerByIdMock = (viewerDatabase as unknown as { getViewerById: jest.Mock }).getViewerById;
const calculateAutoRanksMock = (viewerDatabase as unknown as { calculateAutoRanks: jest.Mock }).calculateAutoRanks;
const isViewerDBOnMock = (viewerDatabase as unknown as { isViewerDBOn: jest.Mock }).isViewerDBOn;
const getViewerDbMock = (viewerDatabase as unknown as { getViewerDb: jest.Mock }).getViewerDb;

const updateAsyncMock = jest.fn().mockResolvedValue({ numAffected: 1 });

const TWITCH_RAW_ID = "12345678";
const SCOPED_ID = `twitch:${TWITCH_RAW_ID}`;

function makeStoredViewer(): FirebotViewer {
    return {
        _id: SCOPED_ID,
        platform: "twitch",
        username: "testuser",
        displayName: "Test User",
        profilePicUrl: "",
        twitch: true,
        twitchRoles: [],
        online: false,
        onlineAt: 0,
        lastSeen: 0,
        joinDate: 0,
        minutesInChannel: 0,
        chatMessages: 0,
        disableAutoStatAccrual: false,
        disableActiveUserList: false,
        disableViewerList: false,
        metadata: {},
        currency: {},
        ranks: {}
    };
}

beforeEach(() => {
    getViewerDbMock.mockReturnValue({ updateAsync: updateAsyncMock });
    isViewerDBOnMock.mockReturnValue(true);
});

describe("viewer-online-status-manager re-key regression (WS-3)", () => {
    describe("setChatViewerOnline", () => {
        it("updates via the scoped record _id when chat hands it a RAW Twitch id (D9 regression)", async () => {
            getViewerByIdMock.mockResolvedValue(makeStoredViewer());

            await viewerOnlineStatusManager.setChatViewerOnline({
                id: TWITCH_RAW_ID,
                username: "testuser",
                displayName: "Test User",
                twitchRoles: []
            });

            expect(getViewerByIdMock).toHaveBeenCalledWith(TWITCH_RAW_ID);

            // exactly one DB write, hitting the SCOPED record key
            expect(updateAsyncMock).toHaveBeenCalledTimes(1);
            expect(updateAsyncMock).toHaveBeenCalledWith(
                { _id: SCOPED_ID },
                { $set: expect.objectContaining({
                    online: true,
                    username: "testuser",
                    displayName: "Test User"
                }) }
            );

            // the pre-re-key behavior (raw _id write) would have missed the record
            expect(updateAsyncMock.mock.calls[0][0]._id).not.toBe(TWITCH_RAW_ID);

            expect(calculateAutoRanksMock).toHaveBeenCalledWith(SCOPED_ID);
        });

        it("passes through an already-scoped chat-packet id to the same record", async () => {
            getViewerByIdMock.mockResolvedValue(makeStoredViewer());

            await viewerOnlineStatusManager.setChatViewerOnline({
                id: SCOPED_ID,
                username: "testuser",
                displayName: "Test User"
            });

            expect(getViewerByIdMock).toHaveBeenCalledWith(SCOPED_ID);
            expect(updateAsyncMock).toHaveBeenCalledWith({ _id: SCOPED_ID }, expect.objectContaining({ $set: expect.anything() }));
        });

        it("does not touch the DB when the viewer is not in the viewer database yet", async () => {
            getViewerByIdMock.mockResolvedValue(null);

            await expect(viewerOnlineStatusManager.setChatViewerOnline({
                id: TWITCH_RAW_ID,
                username: "unknownuser",
                displayName: "Unknown User"
            })).resolves.not.toThrow();

            expect(updateAsyncMock).not.toHaveBeenCalled();
            expect(calculateAutoRanksMock).not.toHaveBeenCalled();
        });

        it("does nothing when the viewer database is off", async () => {
            getViewerByIdMock.mockResolvedValue(makeStoredViewer());
            isViewerDBOnMock.mockReturnValue(false);

            await viewerOnlineStatusManager.setChatViewerOnline({
                id: TWITCH_RAW_ID,
                username: "testuser",
                displayName: "Test User"
            });

            expect(updateAsyncMock).not.toHaveBeenCalled();
        });
    });
});
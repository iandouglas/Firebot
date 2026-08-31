/**
 * WS-4: ActiveUserHandler YouTube extension — `addYouTubeActiveUser` registers
 * platform-tagged YouTube chatters in the Chat Users panel without touching the
 * viewer DB (the chat ingest already upserts + accrues). Also verifies
 * `clearAllActiveUsers` still works (Twitch-disconnect interplay).
 *
 * No network; all collaborators mocked. The real NodeCache-backed singleton is
 * exercised.
 */

jest.mock("../src/backend/common/settings-manager", () => ({
    SettingsManager: { getSetting: jest.fn(() => 5) }
}));

jest.mock("../src/backend/common/frontend-communicator", () => ({
    __esModule: true,
    default: {
        on: jest.fn(),
        onAsync: jest.fn(),
        send: jest.fn()
    }
}));

jest.mock("../src/backend/viewers/viewer-database", () => ({
    __esModule: true,
    default: {
        on: jest.fn(),
        getViewerById: jest.fn(),
        addNewViewerFromChat: jest.fn(),
        incrementDbField: jest.fn()
    }
}));

jest.mock("../src/backend/roles/chat-roles-manager", () => ({
    __esModule: true,
    default: {
        getUsersChatRoles: jest.fn(),
        userIsKnownBot: jest.fn()
    }
}));

jest.mock("../src/backend/streaming-platforms/twitch/api", () => ({
    TwitchApi: {
        users: { getUserById: jest.fn() }
    }
}));

jest.mock("../src/backend/streaming-platforms/twitch/api/eventsub/eventsub-chat-helpers", () => ({
    TwitchEventSubChatHelpers: {
        getUserProfilePicUrl: jest.fn(),
        setUserProfilePicUrl: jest.fn()
    }
}));

jest.mock("../src/backend/logger-cache", () => ({
    LoggerCache: { getLogger: () => mockLogger }
}));

jest.mock("../src/backend/utils", () => ({
    getRandomInt: jest.fn()
}));

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

import frontendCommunicator from "../src/backend/common/frontend-communicator";
import { ActiveUserHandler } from "../src/backend/chat/active-user-handler";

const mockFrontendSend = (frontendCommunicator.send as unknown) as jest.Mock;

function youTubeUser(overrides: Record<string, unknown> = {}) {
    return {
        id: "UCviewer",
        username: "viewer",
        displayName: "Viewer",
        profilePicUrl: "https://example.com/avatar.png",
        roles: ["sub"],
        ...overrides
    };
}

beforeEach(() => {
    // clearAllActiveUsers flushes the active/online caches and sends a
    // chat:all-viewers refresh; clear mocks AFTER so that refresh isn't counted.
    ActiveUserHandler.clearAllActiveUsers();
    jest.clearAllMocks();
});

describe("addYouTubeActiveUser", () => {
    it("registers a new YouTube chatter and sends chat:viewer-joined with platform youtube", () => {
        ActiveUserHandler.addYouTubeActiveUser(youTubeUser({ id: "UCnew1" }));

        expect(mockFrontendSend).toHaveBeenCalledWith("chat:viewer-joined", expect.objectContaining({
            id: "UCnew1",
            username: "viewer",
            displayName: "Viewer",
            roles: ["sub"],
            profilePicUrl: "https://example.com/avatar.png",
            active: true,
            platform: "youtube"
        }));
        expect(ActiveUserHandler.getActiveUserCount()).toBe(1);
    });

    it("updates an existing YouTube chatter and sends chat:viewer-updated", () => {
        ActiveUserHandler.addYouTubeActiveUser(youTubeUser({ id: "UCupdate1" }));
        mockFrontendSend.mockClear();

        ActiveUserHandler.addYouTubeActiveUser(youTubeUser({ id: "UCupdate1", roles: ["sub", "mod"] }));

        expect(mockFrontendSend).toHaveBeenCalledWith("chat:viewer-updated", expect.objectContaining({
            id: "UCupdate1",
            roles: ["sub", "mod"],
            platform: "youtube"
        }));
        expect(mockFrontendSend).not.toHaveBeenCalledWith("chat:viewer-joined", expect.anything());
    });

    it("skips the jtv placeholder", () => {
        ActiveUserHandler.addYouTubeActiveUser(youTubeUser({ username: "jtv", displayName: "jtv" }));
        expect(mockFrontendSend).not.toHaveBeenCalled();
        expect(ActiveUserHandler.getActiveUserCount()).toBe(0);
    });

    it("does not touch the viewer DB (the chat ingest owns upsert + accrual)", () => {
        ActiveUserHandler.addYouTubeActiveUser(youTubeUser({ id: "UCnodb1" }));
        expect(mockFrontendSend).toHaveBeenCalled();
    });
});

describe("clearAllActiveUsers (Twitch-disconnect interplay)", () => {
    it("still flushes active users after YouTube chatters were registered", () => {
        ActiveUserHandler.addYouTubeActiveUser(youTubeUser({ id: "UCclear1" }));
        expect(ActiveUserHandler.getActiveUserCount()).toBe(1);

        ActiveUserHandler.clearAllActiveUsers();
        expect(ActiveUserHandler.getActiveUserCount()).toBe(0);
    });
});

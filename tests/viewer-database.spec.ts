import Datastore from "@seald-io/nedb";
import type { FirebotViewer } from "../src/types";

jest.mock("../src/backend/common/frontend-communicator", () => ({
    __esModule: true,
    default: {
        on: jest.fn(),
        onAsync: jest.fn(),
        send: jest.fn(),
        off: jest.fn()
    }
}));

jest.mock("../src/backend/common/settings-manager", () => ({
    SettingsManager: {
        getSetting: jest.fn().mockReturnValue(true)
    }
}));

jest.mock("../src/backend/common/account-access", () => ({
    AccountAccess: {
        getAccounts: jest.fn().mockReturnValue({
            streamer: { userId: "streamer-user-id" },
            bot: { userId: "bot-user-id" }
        })
    }
}));

jest.mock("../src/backend/common/profile-manager", () => ({
    ProfileManager: {
        getPathInProfile: jest.fn((path: string) => path)
    }
}));

jest.mock("../src/backend/events/event-manager", () => ({
    EventManager: {
        triggerEvent: jest.fn()
    }
}));

jest.mock("../src/backend/backup-manager", () => ({
    BackupManager: {
        startBackup: jest.fn()
    }
}));

jest.mock("../src/backend/pronouns/pronoun-manager", () => ({
    FirebotPronounManager: {
        getUserFriendlyPronounString: jest.fn().mockResolvedValue("")
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

jest.mock("../src/backend/streaming-platforms/twitch/api", () => ({
    TwitchApi: {
        users: { getUserById: jest.fn().mockResolvedValue(null) },
        moderation: { getBannedUsers: jest.fn().mockResolvedValue([]) },
        chat: { sendChatMessage: jest.fn().mockResolvedValue(undefined) },
        streamerClient: {}
    }
}));

jest.mock("../src/backend/roles/chat-roles-manager", () => ({
    __esModule: true,
    default: {
        getUsersChatRoles: jest.fn().mockResolvedValue([]),
        userIsKnownBot: jest.fn().mockResolvedValue(false)
    }
}));

jest.mock("../src/backend/roles/team-roles-manager", () => ({
    __esModule: true,
    default: {
        getAllTeamRolesForViewer: jest.fn().mockResolvedValue([])
    }
}));

jest.mock("../src/backend/roles/role-helpers", () => ({
    __esModule: true,
    default: {
        getAllRolesForViewer: jest.fn().mockResolvedValue([])
    }
}));

jest.mock("../src/backend/ranks/rank-manager", () => ({
    __esModule: true,
    default: {
        getRankLadderHelper: jest.fn().mockReturnValue(null),
        getRankLadderHelpers: jest.fn().mockReturnValue([])
    }
}));

jest.mock("../src/backend/currency/currency-access", () => ({
    __esModule: true,
    default: {
        isViewerDBOn: jest.fn().mockReturnValue(true),
        getCurrencies: jest.fn().mockReturnValue({}),
        addCurrencyToNewViewer: jest.fn((viewer: FirebotViewer) => {
            viewer.currency = viewer.currency ?? {};
            return viewer;
        })
    }
}));

import viewerDatabase from "../src/backend/viewers/viewer-database";
import { EventManager } from "../src/backend/events/event-manager";
import frontendCommunicator from "../src/backend/common/frontend-communicator";

const triggerEventMock = EventManager.triggerEvent as unknown as jest.Mock;
const frontendCommunicatorSendMock = frontendCommunicator.send as unknown as jest.Mock;

const TWITCH_RAW_ID = "12345678";
const YOUTUBE_CHANNEL_ID = "UCX6OQ3DkcsbYNE6H8uQQuVA";

function getTestDb(): Datastore<FirebotViewer> {
    return (viewerDatabase as unknown as { _db: Datastore<FirebotViewer> })._db;
}

async function seed(datastore: Datastore<FirebotViewer>, record: FirebotViewer): Promise<void> {
    await datastore.insertAsync(record);
}

function makeViewerRecord(overrides: Partial<FirebotViewer> & { _id: string }): FirebotViewer {
    return {
        platform: "twitch",
        username: "user1",
        displayName: "User 1",
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
        currency: { points: 0 },
        ranks: {},
        ...overrides
    };
}

async function getStoredRecord(scopedId: string): Promise<FirebotViewer> {
    return await getTestDb().findOneAsync({ _id: scopedId });
}

beforeEach(async () => {
    const datastore = new Datastore<FirebotViewer>();
    await datastore.loadDatabaseAsync();
    (viewerDatabase as unknown as { _db: Datastore<FirebotViewer> })._db = datastore;
});

describe("viewer-database re-key (WS-3)", () => {
    describe("createNewViewer (legacy Twitch API)", () => {
        it("stores the record under a twitch-scoped _id with platform 'twitch' (twitch-calls-unchanged regression)", async () => {
            const returned = await viewerDatabase.createNewViewer({
                id: TWITCH_RAW_ID,
                username: "testuser",
                displayName: "Test User",
                profilePicUrl: "https://twitch.example/pic.png",
                twitchRoles: ["mod"],
                online: true
            });

            const stored = await getStoredRecord(`twitch:${TWITCH_RAW_ID}`);
            expect(stored).toMatchObject({
                _id: `twitch:${TWITCH_RAW_ID}`,
                platform: "twitch",
                twitch: true,
                username: "testuser",
                displayName: "Test User"
            });

            // legacy callers keep receiving raw platform ids on the returned record
            expect(returned).toMatchObject({ _id: TWITCH_RAW_ID, platform: "twitch" });
        });

        it("fires the viewer-created event with the raw userId", async () => {
            await viewerDatabase.createNewViewer({
                id: TWITCH_RAW_ID,
                username: "testuser",
                displayName: "Test User"
            });

            expect(triggerEventMock).toHaveBeenCalledWith("firebot", "viewer-created", {
                username: "testuser",
                userId: TWITCH_RAW_ID,
                userDisplayName: "Test User"
            });
        });

        it("sends the frontend a record carrying the raw _id", async () => {
            await viewerDatabase.createNewViewer({
                id: TWITCH_RAW_ID,
                username: "testuser",
                displayName: "Test User"
            });

            expect(frontendCommunicatorSendMock).toHaveBeenCalledWith(
                "viewer-database:viewer-created",
                expect.objectContaining({ _id: TWITCH_RAW_ID })
            );
        });

        it("never double-ids: exactly one record exists for the viewer", async () => {
            await viewerDatabase.createNewViewer({
                id: TWITCH_RAW_ID,
                username: "testuser",
                displayName: "Test User"
            });

            await expect(getTestDb().countAsync({})).resolves.toBe(1);
        });

        it("creates YouTube-shaped records when NewFirebotViewer.platform is 'youtube'", async () => {
            const returned = await viewerDatabase.createNewViewer({
                id: YOUTUBE_CHANNEL_ID,
                platform: "youtube",
                username: "channel name",
                displayName: "Channel Name"
            });

            expect(returned).toMatchObject({
                _id: YOUTUBE_CHANNEL_ID,
                platform: "youtube",
                twitch: false
            });
            await expect(getStoredRecord(`youtube:${YOUTUBE_CHANNEL_ID}`)).not.toBeNull();
        });
    });

    describe("getViewerById / getViewerByUserId / getViewerByScopedId", () => {
        beforeEach(async () => {
            await seed(getTestDb(), makeViewerRecord({ _id: `twitch:${TWITCH_RAW_ID}` }));
            await seed(getTestDb(), makeViewerRecord({
                _id: `youtube:${YOUTUBE_CHANNEL_ID}`,
                platform: "youtube",
                twitch: false,
                username: "channel name"
            }));
        });

        it("finds a Twitch viewer from its raw id", async () => {
            await expect(viewerDatabase.getViewerById(TWITCH_RAW_ID)).resolves.toMatchObject({
                _id: `twitch:${TWITCH_RAW_ID}`
            });
        });

        it("finds a viewer from an already-scoped id", async () => {
            await expect(viewerDatabase.getViewerById(`twitch:${TWITCH_RAW_ID}`)).resolves.toMatchObject({
                _id: `twitch:${TWITCH_RAW_ID}`
            });
        });

        it("getViewerByUserId delegates to the same scoped lookup", async () => {
            await expect(viewerDatabase.getViewerByUserId(TWITCH_RAW_ID)).resolves.toMatchObject({
                _id: `twitch:${TWITCH_RAW_ID}`
            });
        });

        it("returns null for unknown raw ids", async () => {
            await expect(viewerDatabase.getViewerById("000000")).resolves.toBeNull();
        });

        it("getViewerByScopedId finds twitch records with (platform, rawId)", async () => {
            await expect(viewerDatabase.getViewerByScopedId("twitch", TWITCH_RAW_ID)).resolves.toMatchObject({
                _id: `twitch:${TWITCH_RAW_ID}`
            });
        });

        it("getViewerByScopedId finds youtube records with (platform, rawId)", async () => {
            await expect(viewerDatabase.getViewerByScopedId("youtube", YOUTUBE_CHANNEL_ID)).resolves.toMatchObject({
                _id: `youtube:${YOUTUBE_CHANNEL_ID}`
            });
        });

        it("getViewerByScopedId returns null instead of cross-matching platform scopes", async () => {
            await expect(viewerDatabase.getViewerByScopedId("youtube", TWITCH_RAW_ID)).resolves.toBeNull();
            await expect(viewerDatabase.getViewerByScopedId("twitch", YOUTUBE_CHANNEL_ID)).resolves.toBeNull();
        });
    });

    describe("getViewerByUsername (Twitch-only)", () => {
        beforeEach(async () => {
            await seed(getTestDb(), makeViewerRecord({
                _id: `twitch:${TWITCH_RAW_ID}`,
                username: "testuser"
            }));
            await seed(getTestDb(), makeViewerRecord({
                _id: `youtube:${YOUTUBE_CHANNEL_ID}`,
                platform: "youtube",
                twitch: false,
                username: "testuser"
            }));
        });

        it("returns only the twitch record, even when a youtube record shares the username", async () => {
            await expect(viewerDatabase.getViewerByUsername("testuser")).resolves.toMatchObject({
                _id: `twitch:${TWITCH_RAW_ID}`
            });
        });

        it("is case-insensitive and returns null for unknown usernames", async () => {
            await expect(viewerDatabase.getViewerByUsername("TestUser")).resolves.toMatchObject({
                _id: `twitch:${TWITCH_RAW_ID}`
            });
            await expect(viewerDatabase.getViewerByUsername("nobody")).resolves.toBeNull();
        });
    });

    describe("upsertYouTubeViewer", () => {
        it("creates a record on first call and updates it on the second (create-then-update)", async () => {
            const created = await viewerDatabase.upsertYouTubeViewer(YOUTUBE_CHANNEL_ID, {
                displayName: "Channel Name",
                avatarUrl: "https://yt.example/avatar1.png"
            });

            expect(created).toMatchObject({
                _id: `youtube:${YOUTUBE_CHANNEL_ID}`,
                platform: "youtube",
                twitch: false,
                displayName: "Channel Name",
                profilePicUrl: "https://yt.example/avatar1.png"
            });

            const updated = await viewerDatabase.upsertYouTubeViewer(YOUTUBE_CHANNEL_ID, {
                displayName: "Renamed Channel",
                avatarUrl: "https://yt.example/avatar2.png"
            });

            expect(updated._id).toBe(`youtube:${YOUTUBE_CHANNEL_ID}`);
            expect(updated).toMatchObject({
                displayName: "Renamed Channel",
                profilePicUrl: "https://yt.example/avatar2.png",
                platform: "youtube"
            });

            await expect(getTestDb().countAsync({})).resolves.toBe(1);

            const stored = await getStoredRecord(`youtube:${YOUTUBE_CHANNEL_ID}`);
            expect(stored).toMatchObject({
                displayName: "Renamed Channel",
                profilePicUrl: "https://yt.example/avatar2.png"
            });
        });

        it("fires the viewer-created event (with raw channel id) only on create", async () => {
            await viewerDatabase.upsertYouTubeViewer(YOUTUBE_CHANNEL_ID, { displayName: "Channel Name" });
            expect(triggerEventMock).toHaveBeenCalledTimes(1);
            expect(triggerEventMock).toHaveBeenCalledWith("firebot", "viewer-created", expect.objectContaining({
                userId: YOUTUBE_CHANNEL_ID
            }));

            await viewerDatabase.upsertYouTubeViewer(YOUTUBE_CHANNEL_ID, { displayName: "Renamed" });
            expect(triggerEventMock).toHaveBeenCalledTimes(1);
        });

        it("keeps existing values when upsert info omits them", async () => {
            await viewerDatabase.upsertYouTubeViewer(YOUTUBE_CHANNEL_ID, {
                displayName: "Channel Name",
                avatarUrl: "https://yt.example/avatar1.png"
            });

            const untouched = await viewerDatabase.upsertYouTubeViewer(YOUTUBE_CHANNEL_ID, { displayName: "Channel Name" });

            expect(untouched).toMatchObject({
                displayName: "Channel Name",
                profilePicUrl: "https://yt.example/avatar1.png"
            });
        });

        it("the positional alias createOrUpdateYoutubeViewer creates the same record", async () => {
            const created = await viewerDatabase.createOrUpdateYoutubeViewer(YOUTUBE_CHANNEL_ID, "Channel Name", "https://yt.example/a.png");
            expect(created).toMatchObject({
                _id: `youtube:${YOUTUBE_CHANNEL_ID}`,
                displayName: "Channel Name",
                platform: "youtube"
            });
        });
    });

    describe("id write boundaries scope raw ids", () => {
        beforeEach(async () => {
            await viewerDatabase.createNewViewer({
                id: TWITCH_RAW_ID,
                username: "testuser",
                displayName: "Test User"
            });
        });

        it("updateViewer accepts a legacy raw-_id record", async () => {
            const viewer = await getStoredRecord(`twitch:${TWITCH_RAW_ID}`);
            const legacyShapedViewer = { ...viewer, _id: TWITCH_RAW_ID, minutesInChannel: 55 };

            await expect(viewerDatabase.updateViewer(legacyShapedViewer)).resolves.toBe(true);
            await expect(getStoredRecord(`twitch:${TWITCH_RAW_ID}`)).resolves.toMatchObject({ minutesInChannel: 55 });
        });

        it("updateViewerDataField / updateDbCell write through raw ids", async () => {
            await viewerDatabase.updateViewerDataField(TWITCH_RAW_ID, "chatMessages", 7);
            await expect(getStoredRecord(`twitch:${TWITCH_RAW_ID}`)).resolves.toMatchObject({ chatMessages: 7 });

            await viewerDatabase.updateDbCell({ userId: TWITCH_RAW_ID, field: "minutesInChannel", value: 9 });
            await expect(getStoredRecord(`twitch:${TWITCH_RAW_ID}`)).resolves.toMatchObject({ minutesInChannel: 9 });
        });

        it("incrementDbField increments through raw ids", async () => {
            await viewerDatabase.incrementDbField(TWITCH_RAW_ID, "chatMessages");
            await expect(getStoredRecord(`twitch:${TWITCH_RAW_ID}`)).resolves.toMatchObject({ chatMessages: 1 });
        });

        it("removeViewer removes the scoped record from a raw id and reports the raw id", async () => {
            await expect(viewerDatabase.removeViewer(TWITCH_RAW_ID)).resolves.toBe(true);
            await expect(getStoredRecord(`twitch:${TWITCH_RAW_ID}`)).resolves.toBeNull();
            expect(frontendCommunicatorSendMock).toHaveBeenCalledWith(
                "viewer-database:viewer-deleted",
                TWITCH_RAW_ID
            );
        });

        it("currency fields live on the scoped record and round-trip by record _id", async () => {
            const viewer = await viewerDatabase.getViewerById(TWITCH_RAW_ID);
            expect(viewer._id).toBe(`twitch:${TWITCH_RAW_ID}`);

            await getTestDb().updateAsync(
                { _id: viewer._id },
                { $set: { "currency.points": 42 } }
            );

            const reloaded = await viewerDatabase.getViewerById(TWITCH_RAW_ID);
            expect(reloaded.currency.points).toBe(42);
            expect(reloaded).toMatchObject({ platform: "twitch", _id: `twitch:${TWITCH_RAW_ID}` });
        });
    });

    describe("applyLegacyPlatformSweep (defensive startup sweep)", () => {
        it("stamps legacy raw-id records: numeric => twitch, UC-shaped => youtube", async () => {
            await seed(getTestDb(), makeViewerRecord({ _id: "987654321", platform: undefined }));
            await seed(getTestDb(), makeViewerRecord({ _id: YOUTUBE_CHANNEL_ID, platform: undefined, twitch: false }));

            await expect(viewerDatabase.applyLegacyPlatformSweep()).resolves.toBe(2);

            await expect(getStoredRecord("987654321")).resolves.toMatchObject({ platform: "twitch" });
            await expect(getStoredRecord(YOUTUBE_CHANNEL_ID)).resolves.toMatchObject({ platform: "youtube" });
        });

        it("stamps nothing when platforms already exist", async () => {
            await seed(getTestDb(), makeViewerRecord({ _id: `twitch:${TWITCH_RAW_ID}` }));
            await seed(getTestDb(), makeViewerRecord({
                _id: `youtube:${YOUTUBE_CHANNEL_ID}`,
                platform: "youtube",
                twitch: false
            }));

            await expect(viewerDatabase.applyLegacyPlatformSweep()).resolves.toBe(0);
        });

        it("treats null platform values as missing and stamps nothing twice", async () => {
            await seed(getTestDb(), makeViewerRecord({ _id: `twitch:${TWITCH_RAW_ID}`, platform: null }));

            await expect(viewerDatabase.applyLegacyPlatformSweep()).resolves.toBe(1);
            await expect(getStoredRecord(`twitch:${TWITCH_RAW_ID}`)).resolves.toMatchObject({ platform: "twitch" });
            await expect(viewerDatabase.applyLegacyPlatformSweep()).resolves.toBe(0);
        });

        it("keeps other fields intact while stamping a scoped record missing platform", async () => {
            await seed(getTestDb(), makeViewerRecord({
                _id: `twitch:${TWITCH_RAW_ID}`,
                platform: undefined,
                username: "legacyuser",
                chatMessages: 12
            }));

            await viewerDatabase.applyLegacyPlatformSweep();

            const record = await getStoredRecord(`twitch:${TWITCH_RAW_ID}`);
            expect(record).toMatchObject({
                platform: "twitch",
                username: "legacyuser",
                chatMessages: 12
            });
        });
    });

    describe("event + frontend surfaces keep raw ids", () => {
        it("viewer-rank-updated metadata carries the raw userId", async () => {
            const ladderHelper = {
                isRankHigher: jest.fn(() => true),
                announcePromotionsInChat: false,
                getRank: jest.fn(() => ({ name: "Some Rank", id: "rank-1" })),
                promotionMessageTemplate: "",
                getRankValueDescription: jest.fn(() => "")
            };
            await seed(getTestDb(), makeViewerRecord({
                _id: `twitch:${TWITCH_RAW_ID}`,
                ranks: {}
            }));

            const rankManager = await import("../src/backend/ranks/rank-manager");
            (rankManager.default.getRankLadderHelper as jest.Mock).mockReturnValue(ladderHelper);

            const viewer = await viewerDatabase.getViewerById(TWITCH_RAW_ID);
            await viewerDatabase.setViewerRank(viewer, "ladder-1", "rank-1");

            expect(triggerEventMock).toHaveBeenCalledWith(
                "firebot",
                "viewer-rank-updated",
                expect.objectContaining({ userId: TWITCH_RAW_ID })
            );
        });

        it("getUserDetails returns firebotData with raw _id for a youtube viewer without touching Twitch", async () => {
            await seed(getTestDb(), makeViewerRecord({
                _id: `youtube:${YOUTUBE_CHANNEL_ID}`,
                platform: "youtube",
                twitch: false
            }));

            const { TwitchApi } = await import("../src/backend/streaming-platforms/twitch/api");

            const details = await viewerDatabase.getUserDetails(`youtube:${YOUTUBE_CHANNEL_ID}`);

            expect(details.firebotData._id).toBe(YOUTUBE_CHANNEL_ID);
            expect(details.twitchData).toBeUndefined();
            expect(TwitchApi.users.getUserById).not.toHaveBeenCalled();
        });
    });
});
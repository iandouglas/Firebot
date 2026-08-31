/**
 * WS-7 regression + YouTube-path tests for CurrencyManager.adjustCurrencyForViewerById.
 *
 * The pre-WS-7 implementation re-resolved the id-found record by USERNAME via
 * viewerDatabase.getViewerByUsername — a Twitch-only lookup (matches
 * `twitch: true` records only), so YouTube adjustments always returned false
 * even when the id lookup succeeded (WS-3 audit item 3).
 *
 * Twitch call sites must behave EXACTLY as before (all Twitch callers unchanged);
 * the YouTube path resolves/adjusts the "youtube:<id>" record directly.
 */

jest.mock("../src/backend/currency/currency-access", () => ({
    __esModule: true,
    default: {
        on: jest.fn(),
        isViewerDBOn: jest.fn().mockReturnValue(true),
        loadCurrencies: jest.fn(),
        getCurrencies: jest.fn().mockReturnValue({
            points: { id: "points", name: "Points", limit: 0, payout: 0, interval: 1, active: true },
            coins: { id: "coins", name: "Coins", limit: 500, payout: 0, interval: 1, active: true }
        }),
        getCurrencyById: jest.fn(),
        getCurrencyByName: jest.fn(),
        addCurrencyToNewViewer: jest.fn()
    }
}));

jest.mock("../src/backend/viewers/viewer-database", () => ({
    __esModule: true,
    default: {
        getViewerById: jest.fn(),
        getViewerByUsername: jest.fn(),
        getViewerByScopedId: jest.fn(),
        getViewerByUserId: jest.fn(),
        upsertYouTubeViewer: jest.fn(),
        getViewerDb: jest.fn(),
        calculateAutoRanks: jest.fn()
    }
}));

jest.mock("../src/backend/viewers/viewer-online-status-manager", () => ({
    __esModule: true,
    default: {}
}));

jest.mock("../src/backend/events/event-manager", () => ({
    EventManager: {
        triggerEvent: jest.fn()
    }
}));

jest.mock("../src/backend/common/frontend-communicator", () => ({
    __esModule: true,
    default: {
        on: jest.fn(),
        onAsync: jest.fn(),
        send: jest.fn(),
        sendAsync: jest.fn()
    }
}));

jest.mock("../src/backend/common/connection-manager", () => ({
    ConnectionManager: {
        streamerIsOnline: false
    }
}));

jest.mock("../src/backend/chat/twitch-chat", () => ({
    __esModule: true,
    default: {
        on: jest.fn(),
        chatIsConnected: false
    }
}));

jest.mock("../src/backend/streaming-platforms/twitch/api", () => ({
    TwitchApi: {
        chat: {
            sendChatMessage: jest.fn()
        }
    }
}));

jest.mock("../src/backend/roles/custom-roles-manager", () => ({
    __esModule: true,
    default: {}
}));

jest.mock("../src/backend/roles/firebot-roles-manager", () => ({
    __esModule: true,
    default: {}
}));

jest.mock("../src/backend/roles/team-roles-manager", () => ({
    __esModule: true,
    default: {}
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

import currencyManager from "../src/backend/currency/currency-manager";
import currencyAccess from "../src/backend/currency/currency-access";
import viewerDatabase from "../src/backend/viewers/viewer-database";
import { EventManager } from "../src/backend/events/event-manager";
import type { FirebotViewer } from "../src/types";

const isViewerDBOnMock = (currencyAccess as unknown as { isViewerDBOn: jest.Mock }).isViewerDBOn;
const getViewerByIdMock = (viewerDatabase as unknown as { getViewerById: jest.Mock }).getViewerById;
const getViewerByUsernameMock = (viewerDatabase as unknown as { getViewerByUsername: jest.Mock }).getViewerByUsername;
const getViewerByScopedIdMock = (viewerDatabase as unknown as { getViewerByScopedId: jest.Mock }).getViewerByScopedId;
const upsertYouTubeViewerMock = (viewerDatabase as unknown as { upsertYouTubeViewer: jest.Mock }).upsertYouTubeViewer;
const calculateAutoRanksMock = (viewerDatabase as unknown as { calculateAutoRanks: jest.Mock }).calculateAutoRanks;
const triggerEventMock = EventManager.triggerEvent as unknown as jest.Mock;

const updateAsyncMock = jest.fn().mockResolvedValue({ numAffected: 1 });

const TWITCH_RAW_ID = "12345678";
const TWITCH_VIEWER: FirebotViewer = {
    _id: `twitch:${TWITCH_RAW_ID}`,
    platform: "twitch",
    username: "twitchuser",
    displayName: "TwitchUser",
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
    currency: { points: 100 },
    ranks: {}
};

const YOUTUBE_RAW_ID = "UCFirebotTestViewer00000001";
const YOUTUBE_VIEWER: FirebotViewer = {
    _id: `youtube:${YOUTUBE_RAW_ID}`,
    platform: "youtube",
    username: "ytviewer",
    displayName: "YTViewer",
    profilePicUrl: "",
    twitch: false,
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
    currency: { points: 50 },
    ranks: {}
};

beforeEach(() => {
    jest.clearAllMocks();
    isViewerDBOnMock.mockReturnValue(true);
    (viewerDatabase as unknown as { getViewerDb: jest.Mock }).getViewerDb.mockReturnValue({
        updateAsync: updateAsyncMock
    });
    updateAsyncMock.mockClear();
    triggerEventMock.mockClear();
});

function clone<T extends object>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

describe("currency-manager Twitch path (existing callers unchanged, WS-7 regression)", () => {
    it("raw Twitch id resolves by id then by username and adjusts the twitch:<id> record", async () => {
        const twitchRecord = clone(TWITCH_VIEWER);
        getViewerByIdMock.mockResolvedValue(twitchRecord);
        getViewerByUsernameMock.mockResolvedValue(clone(TWITCH_VIEWER));

        const result = await currencyManager.adjustCurrencyForViewerById(TWITCH_RAW_ID, "points", 25);

        expect(result).toBe(true);
        expect(getViewerByIdMock).toHaveBeenCalledWith(TWITCH_RAW_ID);
        // The Twitch-only username re-resolution is preserved for Twitch viewers.
        expect(getViewerByUsernameMock).toHaveBeenCalledWith("twitchuser");
        expect(updateAsyncMock).toHaveBeenCalledWith(
            { _id: `twitch:${TWITCH_RAW_ID}` },
            { $set: { "currency.points": 125 } },
            {}
        );
        expect(triggerEventMock).toHaveBeenCalledWith("firebot", "currency-update", expect.objectContaining({
            username: "twitchuser",
            currencyId: "points",
            previousCurrencyAmount: 100,
            newCurrencyAmount: 125
        }));
        expect(calculateAutoRanksMock).toHaveBeenCalledWith(`twitch:${TWITCH_RAW_ID}`, "currency");
    });

    it("already-scoped twitch:<id> ids take the scoped lookup and still land on the username path", async () => {
        getViewerByScopedIdMock.mockResolvedValue(clone(TWITCH_VIEWER));
        getViewerByUsernameMock.mockResolvedValue(clone(TWITCH_VIEWER));

        const result = await currencyManager.adjustCurrencyForViewerById(`twitch:${TWITCH_RAW_ID}`, "points", -25);

        expect(result).toBe(true);
        expect(getViewerByScopedIdMock).toHaveBeenCalledWith("twitch", TWITCH_RAW_ID);
        expect(getViewerByUsernameMock).toHaveBeenCalledWith("twitchuser");
        expect(updateAsyncMock).toHaveBeenCalledWith(
            { _id: `twitch:${TWITCH_RAW_ID}` },
            { $set: { "currency.points": 75 } },
            {}
        );
    });

    it("unknown Twitch id returns null without username lookup, upsert, or DB write", async () => {
        getViewerByIdMock.mockResolvedValue(null);

        const result = await currencyManager.adjustCurrencyForViewerById("40040404", "points", 10);

        expect(result).toBeNull();
        expect(getViewerByUsernameMock).not.toHaveBeenCalled();
        expect(upsertYouTubeViewerMock).not.toHaveBeenCalled();
        expect(updateAsyncMock).not.toHaveBeenCalled();
        expect(triggerEventMock).not.toHaveBeenCalled();
    });

    it("viewer DB off returns null before any lookup", async () => {
        isViewerDBOnMock.mockReturnValue(false);

        const result = await currencyManager.adjustCurrencyForViewerById(TWITCH_RAW_ID, "points", 10);

        expect(result).toBeNull();
        expect(getViewerByIdMock).not.toHaveBeenCalled();
    });
});

describe("currency-manager YouTube path (WS-3 audit fix)", () => {
    it("scoped youtube:<id> adjusts the youtube record directly and never re-resolves by username", async () => {
        getViewerByScopedIdMock.mockResolvedValue(clone(YOUTUBE_VIEWER));

        const result = await currencyManager.adjustCurrencyForViewerById(`youtube:${YOUTUBE_RAW_ID}`, "points", 10);

        expect(result).toBe(true);
        expect(getViewerByScopedIdMock).toHaveBeenCalledWith("youtube", YOUTUBE_RAW_ID);
        // THE WS-3 regression: prior code re-resolved by username here and
        // returned false for every YouTube viewer.
        expect(getViewerByUsernameMock).not.toHaveBeenCalled();
        expect(updateAsyncMock).toHaveBeenCalledWith(
            { _id: `youtube:${YOUTUBE_RAW_ID}` },
            { $set: { "currency.points": 60 } },
            {}
        );
        expect(triggerEventMock).toHaveBeenCalledWith("firebot", "currency-update", expect.objectContaining({
            username: "ytviewer",
            previousCurrencyAmount: 50,
            newCurrencyAmount: 60
        }));
    });

    it("a raw YouTube channel-id-shaped id resolves against the youtube scope without pre-scoping", async () => {
        getViewerByScopedIdMock.mockResolvedValue({ ...clone(YOUTUBE_VIEWER), currency: { points: 50, coins: 50 } });

        const result = await currencyManager.adjustCurrencyForViewerById(YOUTUBE_RAW_ID, "coins", 40);

        expect(result).toBe(true);
        expect(getViewerByScopedIdMock).toHaveBeenCalledWith("youtube", YOUTUBE_RAW_ID);
        expect(getViewerByIdMock).not.toHaveBeenCalled();
        expect(updateAsyncMock).toHaveBeenCalledWith(
            { _id: `youtube:${YOUTUBE_RAW_ID}` },
            { $set: { "currency.coins": 90 } },
            {}
        );
    });

    it("respects a currency limit for YouTube viewers", async () => {
        getViewerByScopedIdMock.mockResolvedValue({ ...clone(YOUTUBE_VIEWER), currency: { coins: 480 } });

        await currencyManager.adjustCurrencyForViewerById(`youtube:${YOUTUBE_RAW_ID}`, "coins", 40);

        // coins has limit 500 — the over-limit value clamps to the limit.
        expect(updateAsyncMock).toHaveBeenCalledWith(
            { _id: `youtube:${YOUTUBE_RAW_ID}` },
            { $set: { "currency.coins": 500 } },
            {}
        );
    });

    it("overrideValue=true sets the value instead of adjusting (YouTube record)", async () => {
        getViewerByScopedIdMock.mockResolvedValue(clone(YOUTUBE_VIEWER));

        const result = await currencyManager.adjustCurrencyForViewerById(`youtube:${YOUTUBE_RAW_ID}`, "points", 77, true);

        expect(result).toBe(true);
        expect(updateAsyncMock).toHaveBeenCalledWith(
            { _id: `youtube:${YOUTUBE_RAW_ID}` },
            { $set: { "currency.points": 77 } },
            {}
        );
        expect(triggerEventMock).toHaveBeenCalledWith("firebot", "currency-update", expect.objectContaining({
            previousCurrencyAmount: 50,
            newCurrencyAmount: 77
        }));
    });

    it("a YouTube id with no record is created via upsertYouTubeViewer and then adjusted", async () => {
        getViewerByScopedIdMock.mockResolvedValue(null);
        const freshRecord: FirebotViewer = {
            ...clone(YOUTUBE_VIEWER),
            username: YOUTUBE_RAW_ID,
            displayName: YOUTUBE_RAW_ID,
            currency: { points: 0 }
        };
        upsertYouTubeViewerMock.mockResolvedValue(freshRecord);

        const result = await currencyManager.adjustCurrencyForViewerById(YOUTUBE_RAW_ID, "points", 5);

        expect(result).toBe(true);
        expect(upsertYouTubeViewerMock).toHaveBeenCalledWith(YOUTUBE_RAW_ID, { displayName: YOUTUBE_RAW_ID });
        expect(getViewerByUsernameMock).not.toHaveBeenCalled();
        expect(updateAsyncMock).toHaveBeenCalledWith(
            { _id: `youtube:${YOUTUBE_RAW_ID}` },
            { $set: { "currency.points": 5 } },
            {}
        );
    });

    it("viewer DB off also short-circuits the YouTube path", async () => {
        isViewerDBOnMock.mockReturnValue(false);

        const result = await currencyManager.adjustCurrencyForViewerById(`youtube:${YOUTUBE_RAW_ID}`, "points", 5);

        expect(result).toBeNull();
        expect(getViewerByScopedIdMock).not.toHaveBeenCalled();
        expect(upsertYouTubeViewerMock).not.toHaveBeenCalled();
    });
});
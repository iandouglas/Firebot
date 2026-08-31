jest.mock("../src/backend/currency/currency-access", () => ({
    __esModule: true,
    default: {
        isViewerDBOn: jest.fn().mockReturnValue(true),
        loadCurrencies: jest.fn(),
        getCurrencies: jest.fn().mockReturnValue({}),
        getCurrencyById: jest.fn(),
        getCurrencyByName: jest.fn(),
        addCurrencyToNewViewer: jest.fn()
    }
}));

jest.mock("../src/backend/currency/currency-manager", () => ({
    adjustCurrencyForViewer: jest.fn(),
    adjustCurrencyForViewerById: jest.fn(),
    addCurrencyToOnlineViewers: jest.fn(),
    getViewerCurrencyAmount: jest.fn(),
    getViewerCurrencies: jest.fn(),
    getViewerCurrencyRank: jest.fn(),
    purgeCurrencyById: jest.fn(),
    addCurrencyToViewerGroupOnlineViewers: jest.fn(),
    getTopCurrencyHolders: jest.fn(),
    getTopCurrencyPosition: jest.fn(),
    adjustCurrencyForAllViewers: jest.fn()
}));

import currencyDatabase from "../src/backend/database/currencyDatabase";
import currencyManager from "../src/backend/currency/currency-manager";
import currencyAccess from "../src/backend/currency/currency-access";

const adjustCurrencyForUserByIdMock = (currencyManager as unknown as { adjustCurrencyForViewerById: jest.Mock }).adjustCurrencyForViewerById;
const adjustCurrencyForUserMock = (currencyManager as unknown as { adjustCurrencyForViewer: jest.Mock }).adjustCurrencyForViewer;
const getViewerCurrenciesMock = (currencyManager as unknown as { getViewerCurrencies: jest.Mock }).getViewerCurrencies;
const getViewerCurrencyRankMock = (currencyManager as unknown as { getViewerCurrencyRank: jest.Mock }).getViewerCurrencyRank;
const purgeCurrencyByIdMock = (currencyManager as unknown as { purgeCurrencyById: jest.Mock }).purgeCurrencyById;
const addCurrencyToNewViewerMock = (currencyAccess as unknown as { addCurrencyToNewViewer: jest.Mock }).addCurrencyToNewViewer;

const TWITCH_RAW_ID = "12345678";
const YOUTUBE_CHANNEL_ID = "UCX6OQ3DkcsbYNE6H8uQQuVA";

describe("currencyDatabase scoping at the DB boundary (WS-3)", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("adjustCurrencyForUserById (legacy Twitch call sites unchanged)", () => {
        it("scopes raw Twitch ids to twitch:<id> (default platform)", async () => {
            await currencyDatabase.adjustCurrencyForUserById(TWITCH_RAW_ID, "points", 25);

            expect(adjustCurrencyForUserByIdMock).toHaveBeenCalledWith(`twitch:${TWITCH_RAW_ID}`, "points", 25, false);
        });

        it("keeps currency adjustments on the twitch-scoped record key (existing-Twitch-calls-unchanged regression)", async () => {
            // The legacy creation path (real viewer database; covered in depth by
            // viewer-database.spec.ts) yields records keyed "twitch:<id>" with
            // platform "twitch" — boundary scoping here must hit that same key.
            await currencyDatabase.adjustCurrencyForUserById(TWITCH_RAW_ID, "points", 25);

            expect(adjustCurrencyForUserByIdMock).toHaveBeenCalledWith(
                expect.stringMatching(/^twitch:12345678$/),
                "points",
                25,
                false
            );
        });

        it("passes an already-scoped id through untouched", async () => {
            await currencyDatabase.adjustCurrencyForUserById(`twitch:${TWITCH_RAW_ID}`, "points", 25);
            expect(adjustCurrencyForUserByIdMock).toHaveBeenCalledWith(`twitch:${TWITCH_RAW_ID}`, "points", 25, false);
        });

        it("scopes a raw YouTube channel id with the explicit youtube platform", async () => {
            await currencyDatabase.adjustCurrencyForUserById(YOUTUBE_CHANNEL_ID, "points", 10, false, "youtube");

            expect(adjustCurrencyForUserByIdMock).toHaveBeenCalledWith(`youtube:${YOUTUBE_CHANNEL_ID}`, "points", 10, false);
        });

        it("scopes an already-scoped youtube id correctly regardless of platform arg", async () => {
            await currencyDatabase.adjustCurrencyForUserById(`youtube:${YOUTUBE_CHANNEL_ID}`, "points", 10);

            expect(adjustCurrencyForUserByIdMock).toHaveBeenCalledWith(`youtube:${YOUTUBE_CHANNEL_ID}`, "points", 10, false);
        });

        it("does not throw for missing ids (legacy behavior: no-op lookup)", async () => {
            await currencyDatabase.adjustCurrencyForUserById(null, "points", 10);
            expect(adjustCurrencyForUserByIdMock).toHaveBeenCalledWith(null, "points", 10, false);
        });
    });

    describe("id/username ambiguity is preserved", () => {
        it("getUserCurrencies scopes raw ids but leaves usernames untouched when isUsername", async () => {
            await currencyDatabase.getUserCurrencies(TWITCH_RAW_ID);
            expect(getViewerCurrenciesMock).toHaveBeenLastCalledWith(`twitch:${TWITCH_RAW_ID}`, false);

            await currencyDatabase.getUserCurrencies("someuser", true);
            expect(getViewerCurrenciesMock).toHaveBeenLastCalledWith("someuser", true);

            await currencyDatabase.getUserCurrencies(YOUTUBE_CHANNEL_ID, false, "youtube");
            expect(getViewerCurrenciesMock).toHaveBeenLastCalledWith(`youtube:${YOUTUBE_CHANNEL_ID}`, false);
        });

        it("getUserCurrencyRank scopes raw ids but leaves usernames untouched when isUsername", async () => {
            await currencyDatabase.getUserCurrencyRank("points", TWITCH_RAW_ID);
            expect(getViewerCurrencyRankMock).toHaveBeenLastCalledWith("points", `twitch:${TWITCH_RAW_ID}`, false);

            await currencyDatabase.getUserCurrencyRank("points", "someuser", true);
            expect(getViewerCurrencyRankMock).toHaveBeenLastCalledWith("points", "someuser", true);

            await currencyDatabase.getUserCurrencyRank("points", YOUTUBE_CHANNEL_ID, false, "youtube");
            expect(getViewerCurrencyRankMock).toHaveBeenLastCalledWith("points", `youtube:${YOUTUBE_CHANNEL_ID}`, false);
        });

        it("adjustCurrencyForUser is username-based and is never scoped", async () => {
            await currencyDatabase.adjustCurrencyForUser("someuser", "points", 5);
            expect(adjustCurrencyForUserMock).toHaveBeenCalledWith("someuser", "points", 5);
        });
    });

    describe("non-viewer-id exports delegate untouched", () => {
        it("currency metadata helpers still hit currency access/manager without id changes", async () => {
            await currencyDatabase.purgeCurrencyById("points");
            expect(purgeCurrencyByIdMock).toHaveBeenCalledWith("points");

            const viewerRecord = { _id: "anything" };
            currencyDatabase.addCurrencyToNewUser(viewerRecord);
            expect(addCurrencyToNewViewerMock).toHaveBeenCalledWith(viewerRecord);
        });
    });
});
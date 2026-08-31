"use strict";

const currencyAccess = require("../currency/currency-access").default;
const currencyManager = require("../currency/currency-manager");
const {
    isViewerPlatform,
    safeParseViewerId,
    scopeViewerId
} = require("../viewers/viewer-identity");

// Viewer records are keyed "_id = <platform>:<user_id>" (decision D9). This facade's
// public API keeps taking RAW platform ids (Twitch by default), scoping/unscoping
// happens here at the DB boundary and inside the viewer database — never by callers.
const DEFAULT_PLATFORM = "twitch";

/**
 * Resolves a raw platform user id into the scoped viewer id used as `_id` in the
 * viewer database. Already-scoped ids ("<platform>:<id>") pass through untouched,
 * raw ids are scoped with the given platform (default: Twitch), and
 * null/undefined/empty ids are returned as-is (legacy behavior — the lookup
 * functions treat those as "no id provided").
 */
function toScopedViewerId(idOrScopedId, platform) {
    if (typeof idOrScopedId !== "string" || idOrScopedId === "") {
        return idOrScopedId;
    }

    if (safeParseViewerId(idOrScopedId) != null) {
        return idOrScopedId;
    }

    return scopeViewerId(isViewerPlatform(platform) ? platform : DEFAULT_PLATFORM, idOrScopedId);
}

exports.isViewerDBOn = () => currencyAccess.isViewerDBOn();
exports.refreshCurrencyCache = () => currencyAccess.loadCurrencies();
exports.addCurrencyToNewUser = viewer => currencyAccess.addCurrencyToNewViewer(viewer);
exports.getCurrencies = () => currencyAccess.getCurrencies();
exports.getCurrencyById = id => currencyAccess.getCurrencyById(id);
exports.getCurrencyByName = name => currencyAccess.getCurrencyByName(name);

exports.adjustCurrencyForUser = async (...args) => currencyManager.adjustCurrencyForViewer(...args);

/**
 * @param userId raw platform user id (Twitch by default; pass `platform: "youtube"`)
 *   or an already-scoped viewer id ("twitch:<id>" / "youtube:<id>").
 * @param platform optional "twitch" | "youtube"; only used when `userId` is raw. Default "twitch".
 */
exports.adjustCurrencyForUserById = async (userId, currencyId, value, overrideValue = false, platform = DEFAULT_PLATFORM) =>
    currencyManager.adjustCurrencyForViewerById(toScopedViewerId(userId, platform), currencyId, value, overrideValue);

exports.addCurrencyToOnlineUsers = async (...args) => currencyManager.addCurrencyToOnlineViewers(...args);
exports.getUserCurrencyAmount = async (...args) => currencyManager.getViewerCurrencyAmount(...args);

/**
 * @param viewerIdOrUsername username (when `isUsername`) or raw platform id /
 *   already-scoped viewer id (otherwise).
 * @param platform optional "twitch" | "youtube"; only used when the first arg is
 *   a raw id. Default "twitch".
 */
exports.getUserCurrencies = async (viewerIdOrUsername, isUsername = false, platform = DEFAULT_PLATFORM) =>
    currencyManager.getViewerCurrencies(isUsername ? viewerIdOrUsername : toScopedViewerId(viewerIdOrUsername, platform), isUsername);

/**
 * @param currencyId id of the currency to rank.
 * @param viewerIdOrUsername username (when `isUsername`) or raw platform id /
 *   already-scoped viewer id (otherwise).
 * @param platform optional "twitch" | "youtube"; only used when the second arg is
 *   a raw id. Default "twitch".
 */
exports.getUserCurrencyRank = async (currencyId, viewerIdOrUsername, isUsername = false, platform = DEFAULT_PLATFORM) =>
    currencyManager.getViewerCurrencyRank(currencyId, isUsername ? viewerIdOrUsername : toScopedViewerId(viewerIdOrUsername, platform), isUsername);
exports.purgeCurrencyById = async id => currencyManager.purgeCurrencyById(id);
exports.addCurrencyToUserGroupOnlineUsers = async (...args) => currencyManager.addCurrencyToViewerGroupOnlineViewers(...args);
exports.getTopCurrencyHolders = async (...args) => currencyManager.getTopCurrencyHolders(...args);
exports.getTopCurrencyPosition = async (...args) => currencyManager.getTopCurrencyPosition(...args);
exports.adjustCurrencyForAllUsers = async (...args) => currencyManager.adjustCurrencyForAllViewers(...args);
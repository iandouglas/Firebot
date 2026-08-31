import { TypedEmitter } from "tiny-typed-emitter";
import Datastore from "@seald-io/nedb";
import { DateTime } from "luxon";
import type { HelixUser, HelixBan } from "@twurple/api";

import type {
    BasicViewer,
    FirebotViewer,
    FrontendViewer,
    NewFirebotViewer,
    Rank,
    RankLadder
} from "../../types";

import { AccountAccess } from "../common/account-access";
import { BackupManager } from "../backup-manager";
import { EventManager } from "../events/event-manager";
import { FirebotPronounManager } from "../pronouns/pronoun-manager";
import { ProfileManager } from "../common/profile-manager";
import { SettingsManager } from "../common/settings-manager";
import { TwitchApi } from "../streaming-platforms/twitch/api";
import chatRolesManager from "../roles/chat-roles-manager";
import currencyAccess from "../currency/currency-access";
import rankManager from "../ranks/rank-manager";
import roleHelpers from "../roles/role-helpers";
import teamRolesManager from "../roles/team-roles-manager";
import frontendCommunicator from "../common/frontend-communicator";
import { LoggerCache } from "../logger-cache";
import { commafy, escapeRegExp, wait } from "../utils";
import {
    inferViewerPlatformFromId,
    isViewerPlatform,
    safeParseViewerId,
    scopeViewerId,
    unscopeViewerId,
    type ViewerPlatform
} from "./viewer-identity";

interface ViewerDbChangePacket {
    userId: string;
    field: string;
    value: unknown;
}

interface UpdateViewerRankPacket {
    userId: string;
    rankLadderId: string;
    rankId: string;
}

interface ViewerPurgeOptions {
    daysSinceActive: {
        enabled: boolean;
        value?: number;
    };
    viewTimeHours: {
        enabled: boolean;
        value?: number;
    };
    chatMessagesSent: {
        enabled: boolean;
        value?: number;
    };
    banned: {
        enabled: boolean;
    };
}

interface ViewersPageRequest {
    page: number;
    pageSize: number;
    sortField?: string;
    sortReversed?: boolean;
    search?: string;
}

interface ViewersPage {
    viewers: FirebotViewer[];
    total: number;
    totalUnfiltered: number;
}

interface UserDetails {
    firebotData: FirebotViewer;
    twitchData: Record<string, unknown>;
    streamerFollowsUser: boolean;
    userFollowsStreamer: boolean;
    pronouns: string;
}

/**
 * Info for creating or updating a YouTube viewer record. `displayName` is
 * required; `username` (channel handle) and `avatarUrl` are optional updates.
 */
interface YouTubeViewerUpsertData {
    displayName: string;
    username?: string;
    avatarUrl?: string;
}

class ViewerDatabase extends TypedEmitter<{
    "viewer-database-loaded": () => void;
    "updated-viewer-avatar": (event: { userId: string, url: string }) => void;
    "frontend-viewer-updated": (viewer: FrontendViewer) => void;
}> {
    private logger = LoggerCache.getLogger("Viewers");

    private _db: Datastore<FirebotViewer>;
    private _dbCompactionInterval = 60 * 60 * 1000; // 1 hour

    private cancelRankRecalculation = false;
    private _activeViewers: string[] = [];

    constructor() {
        super();

        frontendCommunicator.onAsync("viewer-db-change", async (data: ViewerDbChangePacket) => {
            if (this.isViewerDBOn() !== true) {
                return;
            }

            await this.updateDbCell(data);
        });

        frontendCommunicator.onAsync("get-purge-preview", async (options: ViewerPurgeOptions) => {
            if (this.isViewerDBOn() !== true) {
                return Promise.resolve([]);
            }
            return await this.getPurgeViewers(options);
        });

        frontendCommunicator.onAsync("purge-viewers", async (options: ViewerPurgeOptions) => {
            if (this.isViewerDBOn() !== true) {
                return 0;
            }
            return await this.purgeViewers(options);
        });

        frontendCommunicator.onAsync("viewer-database:get-viewers-page", async (request: ViewersPageRequest) => {
            return await this.getViewersPage(request);
        });

        frontendCommunicator.onAsync("create-firebot-viewer-data", async (viewer: BasicViewer) => {
            return this.createNewViewer({
                id: viewer.id,
                username: viewer.username,
                displayName: viewer.displayName,
                profilePicUrl: viewer.profilePicUrl,
                twitchRoles: viewer.twitchRoles
            });
        });

        frontendCommunicator.onAsync("get-firebot-viewer-data", async (userId: string) => {
            await this.calculateAutoRanks(userId);
            const viewer = await this.getViewerById(userId);
            return viewer == null ? viewer : this._toFrontendViewer(viewer);
        });

        frontendCommunicator.onAsync("remove-viewer-from-db", async (userId: string) => {
            await this.removeViewer(userId);
        });

        frontendCommunicator.onAsync("get-viewer-details", async (userId: string) => {
            return await this.getUserDetails(userId);
        });

        frontendCommunicator.onAsync("update-firebot-viewer-data-field", async (data: ViewerDbChangePacket) => {
            const { userId, field, value } = data;
            await this.updateViewerDataField(userId, field, value);
        });

        frontendCommunicator.onAsync("update-viewer-rank", async (data: UpdateViewerRankPacket) => {
            const { userId, rankLadderId, rankId } = data;
            await this.setViewerRankById(userId, rankLadderId, rankId);
        });

        frontendCommunicator.onAsync("get-viewer-count", async () => {
            return await this._db.countAsync({});
        });

        frontendCommunicator.onAsync("rank-recalculation:start", async (rankLadderId: string) => {
            this.cancelRankRecalculation = false;
            await this.recalculateRanksForAllViewers(rankLadderId);
        });

        frontendCommunicator.on("rank-recalculation:cancel", () => {
            this.cancelRankRecalculation = true;
        });
    }

    /**
     * Checks settings to see if viewer database is enabled.
     * @returns `true` if the viewer database is enabled, or `false` otherwise
     */
    isViewerDBOn(): boolean {
        return SettingsManager.getSetting("ViewerDB");
    }

    async connectViewerDatabase(): Promise<void> {
        this.logger.info('Trying to connect to viewer database...');
        if (this.isViewerDBOn() !== true) {
            return;
        }

        const path = ProfileManager.getPathInProfile("db/users.db");
        this._db = new Datastore({ filename: path });
        try {
            await this._db.loadDatabaseAsync();
        } catch (error) {
            this.logger.info("Error Loading Database: ", (error as Error).message);
            this.logger.info("Failed Database Path: ", path);
        }

        // Setup our automatic compaction interval to shrink filesize.
        this._db.setAutocompactionInterval(this._dbCompactionInterval);
        setInterval(() => {
            this.logger.debug(`Compaction should be happening now. Compaction Interval: ${this._dbCompactionInterval / 1000} seconds`);
        }, this._dbCompactionInterval);

        this.logger.info("Viewer Database Loaded: ", path);

        try {
            await this._db.ensureIndexAsync({ fieldName: "username", unique: false });
            await this._db.ensureIndexAsync({ fieldName: "displayName", unique: false });
        } catch (error) {
            this.logger.error("Error setting up viewer database indexes: ", error);
        }

        // Defensive sweep (D9): stamp `platform` onto any record that predates the
        // "<platform>:<user_id>" re-key. No-op on a fresh install.
        try {
            const stampedCount = await this.applyLegacyPlatformSweep();
            if (stampedCount > 0) {
                this.logger.debug(`Stamped platform field onto ${stampedCount} legacy viewer record(s).`);
            }
        } catch (error) {
            this.logger.error("Error sweeping viewer records for missing platform fields", error);
        }

        this.emit("viewer-database-loaded");
    }

    /**
     * Defensive startup sweep (decision D9): viewer records created before the
     * "<platform>:<user_id>" re-key have no `platform` field. Infers the platform
     * from the record id shape — scoped ids ("twitch:123"/"youtube:UC...") keep
     * their prefix; YouTube channel-shaped ids ("^UC[\w-]{20,}$") are "youtube";
     * everything else is treated as legacy "twitch" — and stamps it.
     *
     * This is a safety net only; it never re-keys or otherwise migrates data.
     *
     * @returns The number of records that were stamped.
     */
    async applyLegacyPlatformSweep(): Promise<number> {
        const staleRecords = await this._db.findAsync({
            $or: [
                { platform: { $exists: false } },
                { platform: null }
            ]
        });

        let stampedCount = 0;
        for (const staleRecord of staleRecords) {
            const platform = safeParseViewerId(staleRecord._id)?.platform ?? inferViewerPlatformFromId(staleRecord._id);

            try {
                const { numAffected } = await this._db
                    .updateAsync({ _id: staleRecord._id }, { $set: { platform: platform as ViewerPlatform } });
                if (numAffected > 0) {
                    stampedCount += 1;
                }
            } catch (error) {
                this.logger.warn(`Failed to stamp platform onto viewer record '${staleRecord._id}'`, error);
            }
        }

        return stampedCount;
    }

    getViewerDb(): Datastore<FirebotViewer> {
        return this._db;
    }

    /**
     * Resolves any viewer id (raw legacy Twitch id, or an already-scoped
     * "<platform>:<id>" id) into the scoped record id used as `_id` in the DB.
     * Callers on the Twitch side keep passing RAW ids; the scoping happens here,
     * inside the DB layer (WS invariant #1).
     */
    private _toScopedViewerId(id: string): string {
        return safeParseViewerId(id)?.platform != null ? id : scopeViewerId("twitch", id);
    }

    /**
     * Strips the platform prefix off a viewer id for surfaces that must carry RAW
     * platform ids (frontend payloads, event metadata, external API calls). Raw ids
     * pass through untouched.
     */
    private _toRawViewerId(scopedOrRawId: string): string {
        return unscopeViewerId(scopedOrRawId);
    }

    /**
     * Returns a shallow copy of a viewer record with `_id` unscoped for
     * Twitch-facing surfaces (frontend payloads), leaving the stored record alone.
     */
    private _toFrontendViewer(viewer: FirebotViewer): FirebotViewer {
        return { ...viewer, _id: this._toRawViewerId(viewer._id) };
    }

    async createNewViewer(viewer: NewFirebotViewer): Promise<FirebotViewer> {
        if (this.isViewerDBOn() !== true) {
            return;
        }

        const platform = isViewerPlatform(viewer.platform) ? viewer.platform : "twitch";

        const streamerUserId = AccountAccess.getAccounts().streamer.userId;
        const botUserId = AccountAccess.getAccounts().bot.userId;

        const disableAutoStatAccrual = viewer.id === streamerUserId || viewer.id === botUserId;

        let viewerToCreate: FirebotViewer = {
            username: viewer.username,
            _id: scopeViewerId(platform, viewer.id),
            platform: platform,
            displayName: viewer.displayName,
            profilePicUrl: viewer.profilePicUrl,
            twitch: platform === "twitch",
            twitchRoles: viewer.twitchRoles || [],
            online: viewer.online,
            onlineAt: Date.now(),
            lastSeen: Date.now(),
            joinDate: Date.now(),
            minutesInChannel: viewer.minutesInChannel || 0,
            chatMessages: 0,
            disableAutoStatAccrual: disableAutoStatAccrual,
            disableActiveUserList: false,
            disableViewerList: false,
            metadata: {},
            currency: {},
            ranks: {}
        };

        // THIS IS WHERE YOU ADD IN ANY DYNAMIC FIELDS THAT ALL VIEWERS SHOULD HAVE.
        // Add in all of our currencies and set them to 0.
        viewerToCreate = currencyAccess.addCurrencyToNewViewer(viewerToCreate);

        // Insert our record into db.
        try {
            const newViewer = await this._db.insertAsync(viewerToCreate);

            void EventManager.triggerEvent("firebot", "viewer-created", {
                username: viewer.username,
                userId: viewer.id,
                userDisplayName: viewer.displayName
            });

            frontendCommunicator.send("viewer-database:viewer-created", this._toFrontendViewer(newViewer as FirebotViewer));

            // Legacy call sites expect `_id` to be the raw platform id; only the
            // DB layer sees the scoped id.
            return this._toFrontendViewer(newViewer as FirebotViewer);
        } catch (error) {
            this.logger.error("Error adding viewer", error);
        }
    }

    async addNewViewerFromChat(viewerDetails: BasicViewer, isOnline = true) {
        return await this.createNewViewer({
            id: viewerDetails.id,
            username: viewerDetails.username,
            displayName: viewerDetails.displayName,
            profilePicUrl: viewerDetails.profilePicUrl,
            twitchRoles: viewerDetails.twitchRoles,
            online: isOnline
        });
    }

    /**
     * Looks up a viewer by id. Twitch call sites keep passing their RAW platform
     * id; YouTube code must use `getViewerByScopedId("youtube", channelId)` or
     * `upsertYouTubeViewer` instead (WS invariant #1).
     * @param id raw Twitch user id, or an already-scoped "<platform>:<id>" id
     * @returns the viewer record, or null when not found
     */
    async getViewerById(id: string): Promise<FirebotViewer> {
        if (this.isViewerDBOn() !== true) {
            return;
        }

        try {
            return await this._db.findOneAsync({ _id: this._toScopedViewerId(id) });
        } catch (error) {
            this.logger.error("Error getting viewer by ID", error);
        }
    }

    /**
     * Legacy Twitch alias for `getViewerById` — kept so existing Twitch call
     * sites need zero edits; both accept raw and already-scoped ids.
     */
    async getViewerByUserId(legacyTwitchId: string): Promise<FirebotViewer> {
        return await this.getViewerById(legacyTwitchId);
    }

    /**
     * Looks up a viewer by its explicit platform + raw platform user id
     * (the record id is built via `scopeViewerId`).
     * @returns the viewer record, or null when not found
     */
    async getViewerByScopedId(platform: ViewerPlatform, rawId: string): Promise<FirebotViewer> {
        if (this.isViewerDBOn() !== true) {
            return;
        }

        try {
            return await this._db.findOneAsync({ _id: scopeViewerId(platform, rawId) });
        } catch (error) {
            this.logger.error("Error getting viewer by scoped ID", error);
        }
    }

    /**
     * DEPRECATED for Twitch-only use. Username lookups only match records with
     * `twitch: true` (YouTube records are never returned).
     * Twitch-only — never call from YouTube code paths (WS invariant #1).
     * YouTube code must key records by channel id via `getViewerByScopedId` or
     * `upsertYouTubeViewer` — YouTube usernames are not unique, not stable,
     * and this lookup intentionally ignores non-Twitch records.
     */
    async getViewerByUsername(username: string): Promise<FirebotViewer> {
        if (this.isViewerDBOn() !== true) {
            return;
        }

        try {
            const searchTerm = new RegExp(`^${username}$`, 'i');

            return await this._db.findOneAsync({ username: { $regex: searchTerm }, twitch: true });
        } catch {
            return;
        }
    }

    /**
     * YouTube upsert path (called by the YouTube integration, WS-4).
     * - no record for `youtube:<channelId>` yet => creates one (`platform: "youtube"`,
     *   `twitch: false`), firing the standard `firebot:viewer-created` event with the
     *   RAW channel id;
     * - record exists => updates displayName/username/avatar when they changed.
     * @param channelId RAW YouTube channel id ("UC...") — never pre-scoped
     * @returns the stored viewer record (with scoped `_id = "youtube:<channelId>"`)
     */
    async upsertYouTubeViewer(channelId: string, viewerInfo: YouTubeViewerUpsertData): Promise<FirebotViewer> {
        if (this.isViewerDBOn() !== true) {
            return;
        }

        const existingViewer = await this.getViewerByScopedId("youtube", channelId);

        if (existingViewer == null) {
            await this.createNewViewer({
                id: channelId,
                platform: "youtube",
                username: viewerInfo.username ?? viewerInfo.displayName,
                displayName: viewerInfo.displayName,
                profilePicUrl: viewerInfo.avatarUrl,
                online: true
            });

            // Return the true stored record so callers always see "youtube:<channelId>".
            return await this.getViewerByScopedId("youtube", channelId);
        }

        const updateDoc: Partial<FirebotViewer> = {};
        if (viewerInfo.displayName != null && viewerInfo.displayName !== existingViewer.displayName) {
            updateDoc.displayName = viewerInfo.displayName;
        }
        if (viewerInfo.username != null && viewerInfo.username !== existingViewer.username) {
            updateDoc.username = viewerInfo.username;
        }
        if (viewerInfo.avatarUrl != null && viewerInfo.avatarUrl !== existingViewer.profilePicUrl) {
            updateDoc.profilePicUrl = viewerInfo.avatarUrl;
        }

        if (Object.keys(updateDoc).length === 0) {
            return existingViewer;
        }

        try {
            const { affectedDocuments } = await this._db.updateAsync(
                { _id: existingViewer._id },
                { $set: updateDoc },
                { returnUpdatedDocs: true }
            );
            return (affectedDocuments as FirebotViewer) ?? existingViewer;
        } catch (error) {
            this.logger.error("Error upserting YouTube viewer", error);
            return existingViewer;
        }
    }

    /**
     * Positional alias for `upsertYouTubeViewer(channelId, {...})`, kept to match
     * the original WS-3 contract name/signature in the build plan.
     */
    async createOrUpdateYoutubeViewer(channelId: string, displayName: string, avatarUrl?: string): Promise<FirebotViewer> {
        return await this.upsertYouTubeViewer(channelId, { displayName: displayName, avatarUrl: avatarUrl });
    }

    async getAllViewers(): Promise<FirebotViewer[]> {
        if (this.isViewerDBOn() !== true) {
            return [];
        }

        return Object.values(await this._db.findAsync({}));
    }

    async getViewersPage({ page, pageSize, sortField, sortReversed, search }: ViewersPageRequest): Promise<ViewersPage> {
        if (this.isViewerDBOn() !== true) {
            return { viewers: [], total: 0, totalUnfiltered: 0 };
        }

        const query: Record<string, unknown> = {};
        if (search != null && search.length > 0) {
            const searchRegex = new RegExp(escapeRegExp(search), "i");
            query.$or = [
                { username: { $regex: searchRegex } },
                { displayName: { $regex: searchRegex } }
            ];
        }

        const sortObj = sortField ? { [sortField]: sortReversed ? -1 : 1 } : {};

        try {
            const totalUnfiltered = await this._db.countAsync({});
            const total = query.$or ? await this._db.countAsync(query) : totalUnfiltered;

            const viewers = await this._db.findAsync(query)
                .sort(sortObj)
                .skip(Math.max(0, (page - 1) * pageSize))
                .limit(pageSize);

            return { viewers, total, totalUnfiltered };
        } catch (error) {
            this.logger.error("Error getting viewers page: ", error);
            return { viewers: [], total: 0, totalUnfiltered: 0 };
        }
    }

    async getAllUsernames(): Promise<string[]> {
        if (this.isViewerDBOn() !== true) {
            return [];
        }

        const projectionObj = {
            displayName: 1
        };

        try {
            const viewers = await this._db.findAsync({ twitch: true })
                .projection(projectionObj);

            return viewers?.map(u => u.displayName) ?? [];
        } catch (error) {
            this.logger.error("Error getting all viewers: ", error);
            return [];
        }
    }

    async getAllUsernamesWithIds(): Promise<{ id: string, username: string, displayName: string }[]> {
        if (this.isViewerDBOn() !== true) {
            return [];
        }

        const projectionObj = {
            displayName: 1,
            username: 1
        };

        try {
            const viewers = await this._db.findAsync({ twitch: true })
                .projection(projectionObj);

            return viewers?.map(u => ({ id: this._toRawViewerId(u._id), username: u.username, displayName: u.displayName })) ?? [];
        } catch (error) {
            this.logger.error("Error getting all viewers: ", error);
            return [];
        }
    }

    async incrementDbField(userId: string, fieldName: string): Promise<void> {
        if (this.isViewerDBOn() !== true) {
            return;
        }

        try {
            const updateDoc = {};
            updateDoc[fieldName] = 1;

            const { affectedDocuments } = await this._db.updateAsync({ _id: this._toScopedViewerId(userId), disableAutoStatAccrual: { $ne: true } }, { $inc: updateDoc }, { returnUpdatedDocs: true });

            if (affectedDocuments) {
                const updateObj = {};
                updateObj[fieldName] = commafy(affectedDocuments[fieldName] as number);

                frontendCommunicator.send("viewer-database:viewer-updated", this._toFrontendViewer(affectedDocuments as FirebotViewer));
            }
        } catch (error) {
            this.logger.error("incrementDbField error", error);
        }
    }

    private sanitizeDbInput(changePacket: ViewerDbChangePacket): ViewerDbChangePacket {
        if (this.isViewerDBOn() !== true) {
            return;
        }
        switch (changePacket.field) {
            case "lastSeen":
            case "joinDate":
                changePacket.value = DateTime.fromJSDate(changePacket.value as Date).toMillis();
                break;
            case "minutesInChannel":
            case "chatMessages":
                changePacket.value = parseInt(changePacket.value as string);
                break;
            default:
        }

        return changePacket;
    }

    async updateDbCell(changePacket: ViewerDbChangePacket): Promise<void> {
        if (this.isViewerDBOn() !== true) {
            return;
        }

        const sanitiedChangePacket = this.sanitizeDbInput(changePacket);
        const id = this._toScopedViewerId(sanitiedChangePacket.userId),
            field = sanitiedChangePacket.field,
            newValue = sanitiedChangePacket.value;

        const updateDoc = {};
        updateDoc[field] = newValue;

        try {
            const { affectedDocuments } = await this._db.updateAsync({ _id: id }, { $set: updateDoc }, { returnUpdatedDocs: true });

            if (affectedDocuments) {
                frontendCommunicator.send("viewer-database:viewer-updated", this._toFrontendViewer(affectedDocuments as FirebotViewer));
            }
        } catch (error) {
            this.logger.error("Error adding currency to viewer.", error);
        }
    }

    async updateViewer(viewer: FirebotViewer): Promise<boolean> {
        if (viewer == null) {
            return false;
        }

        // The query id always carries the scoped DB key; the replacement doc keeps
        // it too so NeDB never sees a mismatched `_id`.
        const scopedId = this._toScopedViewerId(viewer._id);
        const viewerRecord: FirebotViewer = { ...viewer, _id: scopedId };

        try {
            const { affectedDocuments } = await this._db.updateAsync({ _id: scopedId }, viewerRecord, { returnUpdatedDocs: true });

            if (affectedDocuments) {
                frontendCommunicator.send("viewer-database:viewer-updated", this._toFrontendViewer(affectedDocuments as FirebotViewer));
            }

            return true;
        } catch (error) {
            this.logger.warn("Failed to update viewer in DB", error);
            return false;
        }
    }

    async updateViewerDataField(userId: string, field: string, value: unknown): Promise<void> {
        const updateObject = {};
        updateObject[field] = value;

        try {
            const { affectedDocuments } = await this._db.updateAsync({ _id: this._toScopedViewerId(userId) }, { $set: updateObject }, { returnUpdatedDocs: true });

            if (affectedDocuments) {
                frontendCommunicator.send("viewer-database:viewer-updated", this._toFrontendViewer(affectedDocuments as FirebotViewer));
            }
        } catch (error) {
            this.logger.error("Error updating viewer.", error);
        }
    }

    async removeViewer(userId: string): Promise<boolean> {
        if (userId == null) {
            return false;
        }

        try {
            const scopedId = this._toScopedViewerId(userId);
            await this._db.removeAsync({ _id: scopedId }, { });

            frontendCommunicator.send("viewer-database:viewer-deleted", this._toRawViewerId(scopedId));

            return true;
        } catch (error) {
            this.logger.warn("Failed to remove viewer from DB", error);
            return false;
        }
    }

    private getPurgeWherePredicate(options: ViewerPurgeOptions, bannedUsers: HelixBan[]): () => boolean {
        return function () {
            const viewer = this as FirebotViewer;

            if (!viewer.twitch) {
                return false;
            }

            let daysInactive = 0;
            if (options.daysSinceActive.enabled) {
                daysInactive = DateTime.utc().diff(DateTime.fromMillis(viewer.lastSeen), "days").days;
            }
            const viewTimeHours = viewer.minutesInChannel / 60;

            if ((
                options.daysSinceActive.enabled ||
                options.viewTimeHours.enabled ||
                options.chatMessagesSent.enabled ||
                options.banned.enabled
            ) &&
            (!options.daysSinceActive.enabled || daysInactive > options.daysSinceActive.value) &&
            (!options.viewTimeHours.enabled || viewTimeHours < options.viewTimeHours.value) &&
            (!options.chatMessagesSent.enabled || viewer.chatMessages < options.chatMessagesSent.value) &&
            (!options.banned.enabled || bannedUsers.some(u => u.userId === this._toRawViewerId(viewer._id)))) {
                return true;
            }
            return false;
        };
    }

    async getPurgeViewers(options: ViewerPurgeOptions): Promise<FirebotViewer[]> {
        try {
            let bannedUsers: HelixBan[] = [];
            if (options.banned.enabled) {
                bannedUsers = (await TwitchApi.moderation.getBannedUsers()).filter(u => u.expiryDate === null);
            }
            return await this._db.findAsync({ $where: this.getPurgeWherePredicate(options, bannedUsers) });
        } catch {
            return [];
        }
    }

    async purgeViewers(options: ViewerPurgeOptions): Promise<number> {
        await BackupManager.startBackup(false);

        try {
            const bannedUsers = (await TwitchApi.moderation.getBannedUsers()).filter(u => u.expiryDate === null);
            const numRemoved = await this._db
                .removeAsync({ $where: this.getPurgeWherePredicate(options, bannedUsers) }, { multi: true });

            frontendCommunicator.send("viewer-database:viewers-updated");

            return numRemoved;
        } catch {
            return 0;
        }
    }

    async setViewerRank(viewer: FirebotViewer, ladderId: string, newRankId?: string): Promise<void> {
        if (this.isViewerDBOn() !== true) {
            return;
        }

        const ladder = rankManager.getRankLadderHelper(ladderId);
        if (!ladder) {
            return;
        }

        if (viewer.ranks == null) {
            viewer.ranks = {};
        }

        const currentRankId = viewer.ranks[ladderId];
        if (currentRankId === newRankId) {
            return;
        }

        viewer.ranks[ladderId] = newRankId;

        await this.updateViewer(viewer);

        const isPromotion = ladder.isRankHigher(newRankId, currentRankId);

        if (isPromotion && ladder.announcePromotionsInChat && this._isViewerActive(viewer._id)) {
            const newRank = ladder.getRank(newRankId);
            const rankValueDescription = ladder.getRankValueDescription(newRankId);

            const promotionMessageTemplate = ladder.promotionMessageTemplate;
            const promotionMessage = promotionMessageTemplate
                .replace(/{user}/g, viewer.displayName)
                .replace(/{rank}/g, newRank?.name)
                .replace(/{rankDescription}/g, rankValueDescription);
            await TwitchApi.chat.sendChatMessage(promotionMessage, null, true);
        }

        const newRank = ladder.getRank(newRankId);
        const previousRank = ladder.getRank(currentRankId);

        void EventManager.triggerEvent("firebot", "viewer-rank-updated", {
            username: viewer.username,
            userId: this._toRawViewerId(viewer._id),
            userDisplayName: viewer.displayName,
            rankLadderName: ladder.name,
            rankLadderId: ladderId,
            newRankName: newRank?.name,
            newRankId: newRank?.id,
            previousRankName: previousRank?.name,
            previousRankId: previousRank?.id,
            isPromotion: isPromotion,
            isDemotion: !isPromotion
        });
    }

    async setViewerRankById(userId: string, ladderId: string, rankId: string): Promise<void> {
        if (this.isViewerDBOn() !== true) {
            return;
        }

        const viewer = await this.getViewerById(userId);

        if (viewer == null) {
            return;
        }

        await this.setViewerRank(viewer, ladderId, rankId);
    }

    viewerHasRank(viewer: FirebotViewer, ladderId: string, rankId: string): boolean {
        if (this.isViewerDBOn() !== true) {
            return false;
        }

        if (!viewer) {
            return false;
        }

        const ladder = rankManager.getRankLadderHelper(ladderId);

        if (ladder == null) {
            return false;
        }

        if (!ladder.hasRank(rankId)) {
            return false;
        }

        const viewersCurrentRankId = viewer.ranks?.[ladderId] ?? null;

        return rankId === viewersCurrentRankId;
    }

    async viewerHasRankById(userId: string, ladderId: string, rankId: string): Promise<boolean> {
        if (this.isViewerDBOn() !== true) {
            return false;
        }

        const viewer = await this.getViewerById(userId);

        return this.viewerHasRank(viewer, ladderId, rankId);
    }

    async getViewerRankForLadderByUserName(userName: string, ladderId: string): Promise<Rank | null> {
        if (this.isViewerDBOn() !== true) {
            return null;
        }

        const viewer = await this.getViewerByUsername(userName);

        if (viewer == null) {
            return null;
        }

        return await this.getViewerRankForLadder(viewer._id, ladderId);
    }


    async getViewerRankForLadder(userId: string, ladderId: string): Promise<Rank | null> {
        if (this.isViewerDBOn() !== true) {
            return null;
        }

        await this.calculateAutoRanks(userId);

        const viewer = await this.getViewerById(userId);

        const ladder = rankManager.getRankLadderHelper(ladderId);

        if (ladder == null) {
            return null;
        }

        const viewersCurrentRankId = viewer.ranks?.[ladderId] ?? null;

        return ladder.getRank(viewersCurrentRankId);
    }

    async calculateAutoRanks(userId: string, trackByType?: RankLadder["settings"]["trackBy"]): Promise<void> {
        if (this.isViewerDBOn() !== true) {
            return;
        }

        const applicableLadders = rankManager.getRankLadderHelpers()
            .filter(ladder => ladder.mode === "auto" && (trackByType == null || ladder.trackBy === trackByType));

        if (applicableLadders.length === 0) {
            return;
        }

        const viewer = await this.getViewerById(userId);

        if (viewer == null) {
            return;
        }

        if (viewer.ranks == null) {
            viewer.ranks = {};
        }

        for (const ladder of applicableLadders) {

            const currentRankId = viewer.ranks[ladder.id];

            if (ladder.restrictedToRoleIds.length > 0) {
                const userRoles = await roleHelpers.getAllRolesForViewer(this._toRawViewerId(userId));
                if (!userRoles.some(r => ladder.restrictedToRoleIds.includes(r.id))) {
                    if (currentRankId != null) {
                        await this.setViewerRank(viewer, ladder.id, undefined);
                    }
                    continue;
                }
            }

            const highestQualifiedRankId = ladder.getHighestQualifiedRankId(viewer);

            if (currentRankId !== highestQualifiedRankId) {
                await this.setViewerRank(viewer, ladder.id, highestQualifiedRankId);
            }
        }
    }

    async calculateAutoRanksByName(userName: string, trackByType?: RankLadder["settings"]["trackBy"]): Promise<void> {
        if (this.isViewerDBOn() !== true) {
            return;
        }

        const viewer = await this.getViewerByUsername(userName);

        if (viewer == null) {
            return;
        }

        await this.calculateAutoRanks(viewer._id, trackByType);
    }

    async recalculateRanksForAllViewers(rankLadderId: string): Promise<void> {
        const ladder = rankManager.getRankLadderHelper(rankLadderId);

        if (this.isViewerDBOn() !== true || ladder == null) {
            frontendCommunicator.send("rank-recalculation:complete");
            return;
        }

        await wait(1000);

        const viewers = await this.getAllViewers();

        let processedViewers = 0;
        for (const viewer of viewers) {
            if (this.cancelRankRecalculation) {
                this.cancelRankRecalculation = false;
                return;
            }

            if (viewer.ranks == null) {
                viewer.ranks = {};
            }

            const currentRankId = viewer.ranks[ladder.id];
            const highestQualifiedRankId = ladder.getHighestQualifiedRankId(viewer);

            try {
                if (currentRankId !== highestQualifiedRankId) {
                    await this.setViewerRank(viewer, ladder.id, highestQualifiedRankId);
                }

                processedViewers += 1;

                if (processedViewers % 5 === 0) {
                    frontendCommunicator.send("rank-recalculation:progress", processedViewers);
                    await wait(5);
                }
            } catch (error) {
                this.logger.error("Error recalculating ranks for viewer", viewer._id, error);
            }
        }

        frontendCommunicator.send("rank-recalculation:progress", processedViewers);

        await this._db.compactDatafileAsync();

        await wait(1000);

        frontendCommunicator.send("rank-recalculation:complete");
    }

    addActiveViewer(userId: string) {
        const rawId = this._toRawViewerId(userId);
        if (!this._activeViewers.includes(rawId)) {
            this._activeViewers.push(rawId);
        }
    }

    removeActiveViewer(userId: string) {
        const rawId = this._toRawViewerId(userId);
        this._activeViewers = this._activeViewers.filter(v => v !== rawId);
    }

    /**
     * Active viewers are tracked by RAW platform ids (legacy surface); scoped
     * record ids are unscoped for the comparison.
     */
    private _isViewerActive(scopedOrRawViewerId: string): boolean {
        return this._activeViewers.includes(this._toRawViewerId(scopedOrRawViewerId));
    }

    async getUserDetails(userId: string): Promise<Partial<UserDetails>> {
        await this.calculateAutoRanks(userId);

        const rawUserId = this._toRawViewerId(userId);
        const firebotUserData = await this.getViewerById(userId);

        if (firebotUserData != null && !firebotUserData.twitch) {
            return {
                firebotData: this._toFrontendViewer(firebotUserData)
            };
        }

        let twitchUser: HelixUser;
        try {
            twitchUser = await TwitchApi.users.getUserById(rawUserId);
        } catch {
            // fail silently for now
        }

        if (twitchUser == null) {
            return {
                firebotData: firebotUserData == null ? ({} as FirebotViewer) : this._toFrontendViewer(firebotUserData)
            };
        }

        const twitchUserData: Record<string, unknown> = {
            id: twitchUser.id,
            username: twitchUser.name,
            displayName: twitchUser.displayName,
            profilePicUrl: twitchUser.profilePictureUrl,
            creationDate: twitchUser.creationDate
        };

        const userRoles = await chatRolesManager.getUsersChatRoles(twitchUser.id);

        if (firebotUserData) {
            let userUpdated = false;

            if (firebotUserData.username !== twitchUser.name
                || firebotUserData.displayName !== twitchUser.displayName
            ) {
                firebotUserData.username = twitchUser.name;
                firebotUserData.displayName = twitchUser.displayName;
                userUpdated = true;
            }

            if (firebotUserData.profilePicUrl !== twitchUser.profilePictureUrl) {
                this.emit("updated-viewer-avatar", { userId: twitchUser.id, url: twitchUser.profilePictureUrl });

                firebotUserData.profilePicUrl = twitchUser.profilePictureUrl;
                userUpdated = true;
            }

            if (userUpdated) {
                await this.updateViewer(firebotUserData);

                const updatedViewer: FrontendViewer = {
                    id: rawUserId,
                    username: firebotUserData.username,
                    displayName: firebotUserData.displayName,
                    roles: userRoles,
                    profilePicUrl: firebotUserData.profilePicUrl,
                    active: this._isViewerActive(rawUserId)
                };

                this.emit("frontend-viewer-updated", updatedViewer);
            }
        }

        const streamerData = AccountAccess.getAccounts().streamer;

        const client = TwitchApi.streamerClient;

        let isBanned: boolean;
        try {
            isBanned = await client.moderation.checkUserBan(streamerData.userId, twitchUser.id);
        } catch (error) {
            this.logger.warn("Unable to get banned status", error);
        }

        const teamRoles = await teamRolesManager.getAllTeamRolesForViewer(twitchUser.name);

        const userFollowsStreamerResponse = await client.channels.getChannelFollowers(
            streamerData.userId,
            rawUserId
        );

        const streamerFollowsUserResponse = await client.channels.getFollowedChannels(
            streamerData.userId,
            rawUserId
        );

        const streamerFollowsUser = streamerFollowsUserResponse.data != null &&
            streamerFollowsUserResponse.data.length === 1;
        const userFollowsStreamer = userFollowsStreamerResponse.data != null &&
            userFollowsStreamerResponse.data.length === 1;

        if (twitchUserData) {
            twitchUserData.followDate = userFollowsStreamer &&
                userFollowsStreamerResponse.data[0].followDate;
            twitchUserData.isBanned = isBanned;
            twitchUserData.userRoles = userRoles || [];
            twitchUserData.teamRoles = teamRoles || [];
        }

        const userDetails: UserDetails = {
            firebotData: firebotUserData == null ? ({} as FirebotViewer) : this._toFrontendViewer(firebotUserData),
            twitchData: twitchUserData,
            streamerFollowsUser: streamerFollowsUser,
            userFollowsStreamer: userFollowsStreamer,
            pronouns: twitchUserData
                ? await FirebotPronounManager.getUserFriendlyPronounString(twitchUserData.username as string)
                : null
        };

        return userDetails;
    }
}

const viewerDatabase = new ViewerDatabase();

export = viewerDatabase;
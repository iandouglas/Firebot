import frontendCommunicator from "../../../common/frontend-communicator";
import { LoggerCache } from "../../../logger-cache";
import viewerDatabase from "../../../viewers/viewer-database";

import { youtubeAccountStore } from "./account-store";
import {
    YouTubeApiError,
    youtubeChatEvents,
    type YouTubeMembershipLevel
} from "./contracts";
import { youTubeApiClient } from "./youtube-api-client";

const logger = LoggerCache.getLogger("YouTube");

/**
 * WS-9 — YouTube members roster (best-effort).
 *
 * Fetches the channel's member list + membership levels on integration connect
 * and every `refreshIntervalMs` (default 15 min) while the stream is live, then
 * caches a lightweight roster `[{channelId, displayName, levelName}]` and pushes
 * it to the frontend as `youtube:members-updated` (mirroring the WS-1
 * `youtube:bot-auth-update` push shape).
 *
 * ## Graceful degradation (D12 — user may not be enrolled)
 * The `members.list` / `membershipsLevels.list` endpoints require the
 * `youtube.channel-memberships.creator` scope AND YouTube's approval of the
 * project for member data. Pre-enrollment (or a revoked scope) surfaces as a
 * 403 "forbidden" (mapped to kind "other" with httpStatus 403 by the api-client)
 * or an `auth`/`quota` error. Any of those flips `membersApiAvailable` to false,
 * logs a warning ONCE, and retries only on the next scheduled refresh — never in
 * a tight loop. The module otherwise no-ops cleanly, which is the primary
 * acceptance criterion pre-enrollment.
 *
 * ## Role integration (read-only, for future WS)
 * The roster is an *additional* role source only — the per-message `isSponsor`
 * flag from chat ingest remains the primary member signal (D9/D13). Consumers
 * can read the cached roster via `getYouTubeMembersRoster()` /
 * `isMembersApiAvailable()` or subscribe to changes via
 * `subscribeToMembersRoster(callback)`.
 *
 * ## Viewer DB
 * Roster members are upserted into the Viewers DB as `platform:"youtube"`
 * records (throttled per channel) so members exist even before they chat.
 */

/** Default refresh cadence while live (task: "every 15 min while live"). */
export const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/** Per-channel viewer upsert throttle (matches the refresh cadence). */
export const VIEWER_UPSERT_THROTTLE_MS = 15 * 60 * 1000;

/** One cached roster entry. */
export interface YouTubeRosterMember {
    /** RAW YouTube channel id ("UC...") — WS invariant #1. */
    channelId: string;
    displayName: string;
    levelName: string;
}

/** Frontend payload for `youtube:members-updated`. */
export interface YouTubeMembersUpdate {
    available: boolean;
    members: YouTubeRosterMember[];
}

export interface MembersRosterOptions {
    /** Injectable refresh cadence (ms) so tests can use fake timers. */
    refreshIntervalMs?: number;
    /** Injectable per-channel viewer upsert throttle (ms). */
    viewerUpsertThrottleMs?: number;
}

/**
 * True when the members API is gated/unavailable and the roster should be
 * disabled: auth failures, quota exhaustion, or any 403 (member-data gating
 * surfaces as kind "other" with httpStatus 403). Transient kinds (rate-limit,
 * not-found, non-403 "other") keep the last availability and retry next tick.
 */
function isMembersApiUnavailableError(error: unknown): boolean {
    if (!(error instanceof YouTubeApiError)) {
        return false;
    }
    if (error.kind === "auth" || error.kind === "quota") {
        return true;
    }
    // Member-data gating surfaces as a 403 "forbidden" → kind "other" with
    // httpStatus 403. Exclude rate-limit (also a 403) which is transient.
    return error.kind !== "rate-limit" && error.httpStatus === 403;
}

export class YouTubeMembersRoster {
    private _running = false;
    private _live = false;
    private _timer: ReturnType<typeof setTimeout> | null = null;

    private _membersApiAvailable = false;
    private _warnedUnavailable = false;
    private _roster: YouTubeRosterMember[] = [];
    private _levels: YouTubeMembershipLevel[] = [];
    private _lastUpsertAt: Record<string, number> = {};
    private _lastPayloadSent: string | null = null;

    private readonly _refreshIntervalMs: number;
    private readonly _viewerUpsertThrottleMs: number;
    private readonly _subscribers: Array<(update: YouTubeMembersUpdate) => void> = [];

    constructor(options: MembersRosterOptions = {}) {
        this._refreshIntervalMs = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
        this._viewerUpsertThrottleMs = options.viewerUpsertThrottleMs ?? VIEWER_UPSERT_THROTTLE_MS;

        // Track live state so the 15-min refresh only runs while live. The
        // listeners are harmless before start() (they only flip `_live`).
        youtubeChatEvents.on("stream-online", () => {
            this._live = true;
        });
        youtubeChatEvents.on("stream-offline", () => {
            this._live = false;
        });
    }

    /** Begin the roster lifecycle (idempotent). No-op without a linked streamer account. */
    start(): void {
        if (this._running) {
            return;
        }
        if (youtubeAccountStore.getRawAccount("streamer") == null) {
            logger.info("YouTube members roster not started: no streamer account is linked.");
            return;
        }

        logger.info("YouTube members roster started (best-effort; graceful no-op pre-enrollment).");
        this._running = true;
        this._live = false;
        this._warnedUnavailable = false;

        // Initial fetch on connect (task: "fetch on integration connect").
        void this._fetchRoster();
        this._scheduleNextRefresh();
    }

    /** Stop the roster lifecycle and clear cached state (idempotent, safe mid-fetch). */
    stop(): void {
        if (this._timer != null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._running = false;
        this._live = false;
    }

    isRunning(): boolean {
        return this._running;
    }

    /** Whether the members API is currently usable (false pre-enrollment / on 403/quota/auth). */
    isAvailable(): boolean {
        return this._membersApiAvailable;
    }

    getRoster(): YouTubeRosterMember[] {
        return this._roster;
    }

    getLevels(): YouTubeMembershipLevel[] {
        return this._levels;
    }

    /**
     * Subscribe to roster changes (availability + members). Returns an
     * unsubscribe function. Intended for future WS (role integration, WS-10).
     */
    subscribe(callback: (update: YouTubeMembersUpdate) => void): () => void {
        this._subscribers.push(callback);
        return () => {
            const index = this._subscribers.indexOf(callback);
            if (index > -1) {
                this._subscribers.splice(index, 1);
            }
        };
    }

    private _scheduleNextRefresh(): void {
        if (this._timer != null) {
            clearTimeout(this._timer);
        }
        const timer = setTimeout(() => {
            this._timer = null;
            if (!this._running) {
                return;
            }
            // Only refresh while live (task: "every 15 min while live").
            if (this._live) {
                void this._fetchRoster();
            }
            this._scheduleNextRefresh();
        }, this._refreshIntervalMs);
        // Never hold the process open on a pending refresh.
        timer.unref?.();
        this._timer = timer;
    }

    private async _fetchRoster(): Promise<void> {
        try {
            const [membersResult, levels] = await Promise.all([
                youTubeApiClient.listMembers("streamer"),
                youTubeApiClient.listMembershipLevels("streamer")
            ]);

            const levelNameById = new Map(levels.map(level => [level.id, level.displayName]));
            const roster = membersResult.members.map(member => ({
                channelId: member.channelId,
                displayName: member.displayName,
                levelName: member.highestAccessibleLevelDisplayName
                    ?? levelNameById.get(member.highestAccessibleLevel ?? "")
                    ?? "Member"
            }));

            this._roster = roster;
            this._levels = levels;
            this._membersApiAvailable = true;
            if (this._warnedUnavailable) {
                this._warnedUnavailable = false;
                logger.info("YouTube members API is available again; roster enabled.");
            }

            this._pushIfChanged();
            void this._upsertViewers(roster);
        } catch (error) {
            this._handleFetchError(error);
        }
    }

    private _handleFetchError(error: unknown): void {
        const kind = error instanceof YouTubeApiError ? error.kind : "other";
        const message = error instanceof Error ? error.message : String(error);

        if (isMembersApiUnavailableError(error)) {
            this._membersApiAvailable = false;
            if (!this._warnedUnavailable) {
                this._warnedUnavailable = true;
                logger.warn(
                    `YouTube members API unavailable (kind=${kind}): ${message}. Roster disabled; will retry on the next scheduled refresh.`
                );
            }
            this._pushIfChanged();
            return;
        }

        // Transient (rate-limit / not-found / non-403 "other"): keep current
        // availability, log at warn, retry on the next scheduled refresh.
        logger.warn(`YouTube members roster refresh failed (kind=${kind}): ${message}`);
    }

    private async _upsertViewers(roster: YouTubeRosterMember[]): Promise<void> {
        if (viewerDatabase.isViewerDBOn() !== true) {
            return;
        }
        const now = Date.now();
        for (const member of roster) {
            const last = this._lastUpsertAt[member.channelId] ?? 0;
            if (now - last < this._viewerUpsertThrottleMs) {
                continue;
            }
            this._lastUpsertAt[member.channelId] = now;
            try {
                await viewerDatabase.upsertYouTubeViewer(member.channelId, {
                    displayName: member.displayName
                });
            } catch (error) {
                logger.warn(`YouTube members roster: viewer upsert failed for ${member.channelId}:`, error);
            }
        }
    }

    private _pushIfChanged(): void {
        const payload: YouTubeMembersUpdate = {
            available: this._membersApiAvailable,
            members: this._roster
        };
        const serialized = JSON.stringify(payload);
        if (serialized === this._lastPayloadSent) {
            return;
        }
        this._lastPayloadSent = serialized;
        frontendCommunicator.send("youtube:members-updated", payload);
        for (const callback of this._subscribers) {
            try {
                callback(payload);
            } catch (error) {
                logger.warn("YouTube members roster subscriber threw:", error);
            }
        }
    }
}

export const youtubeMembersRoster = new YouTubeMembersRoster();

/** WS-9 lifecycle hook — call from youtube.ts connect() (see report). */
export function startMembersRoster(): void {
    youtubeMembersRoster.start();
}

/** WS-9 lifecycle hook — call from youtube.ts disconnect()/unlink() (see report). */
export function stopMembersRoster(): void {
    youtubeMembersRoster.stop();
}

/** Read-only accessors for future WS (role integration, WS-10). */
export function getYouTubeMembersRoster(): YouTubeRosterMember[] {
    return youtubeMembersRoster.getRoster();
}

export function isMembersApiAvailable(): boolean {
    return youtubeMembersRoster.isAvailable();
}

export function getMembershipLevels(): YouTubeMembershipLevel[] {
    return youtubeMembersRoster.getLevels();
}

export function subscribeToMembersRoster(callback: (update: YouTubeMembersUpdate) => void): () => void {
    return youtubeMembersRoster.subscribe(callback);
}

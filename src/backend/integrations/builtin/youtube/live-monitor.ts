import frontendCommunicator from "../../../common/frontend-communicator";
import { LoggerCache } from "../../../logger-cache";

import { youtubeAccountStore } from "./account-store";
import { startChatIngest, stopChatIngest } from "./chat-ingest";
import {
    YouTubeApiError,
    youtubeChatEvents,
    type YouTubeBroadcast,
    type YouTubeVideoLiveDetails
} from "./contracts";
import { triggerStreamOffline, triggerStreamOnline } from "./triggers/stream-events";
import { youTubeApiClient } from "./youtube-api-client";

const logger = LoggerCache.getLogger("YouTube");

/** Live-check poll cadence (core invariant #3: ≤1,440 units/day — list ops cost 1). */
const POLL_INTERVAL_MS = 60 * 1000;

/** Cadence while in "other"-failure backoff (task: back off to 5 minutes). */
const BACKOFF_INTERVAL_MS = 5 * 60 * 1000;

/** Consecutive kind:"other"/network failures before entering backoff. */
const CONSECUTIVE_FAILURE_BACKOFF_THRESHOLD = 3;

/**
 * Frontend payload sent as `frontendCommunicator.send("youtube:stream-info-update",
 * payload)` — consumed by WS-10 for dashboard display. Sent whenever the payload
 * changes (≈ every poll tick while live as viewer counts move; once when the
 * state settles while offline) plus a final `connected:false` teardown send on stop.
 */
export interface YouTubeStreamInfoUpdate {
    /** Integration connected state; false only in the final send when the monitor stops. */
    connected: boolean;
    /** lifeCycleStatus === "live" for the tracked broadcast. */
    live: boolean;
    /** A broadcast is in "testStarting" (pre-live) — dashboard may show "starting soon". */
    preLive: boolean;
    videoId: string | null;
    title: string | null;
    liveChatId: string | null;
    /** Parsed from the API's string form; null when absent/unparseable. */
    concurrentViewers: number | null;
    totalViewCount: number | null;
    /** ISO timestamp the broadcast actually went live (actualStartTime). */
    startedAt: string | null;
}

export interface YouTubeLiveState {
    videoId: string;
    liveChatId: string | null;
    title: string | null;
    concurrentViewers: number | null;
    totalViewCount: number | null;
    startedAt: string | null;
}

/**
 * 60s live-check poll while the YouTube integration is connected.
 *
 * - `listOwnBroadcasts("streamer")` → the broadcast with
 *   `lifeCycleStatus === "live"`; only that status starts chat + events.
 *   `testStarting` is treated as pre-live (no chat start, no events).
 * - `lifeCycleStatus === "complete"` (or the broadcast leaving the live list,
 *   or being replaced by another broadcast) → offline transition: chat stop +
 *   "stream-offline" on `youtubeChatEvents` + `youtube:stream-offline` event.
 * - `getVideoLiveDetails(videoId)` piggybacks on the same tick while live for
 *   `concurrentViewers` (+1 list unit), pushed to the frontend on change.
 *
 * Transitions fire, in order: `startChatIngest`/`stopChatIngest` (WS-4 hook,
 * wired DIRECTLY here rather than via events — WS-4 must keep these
 * signatures), then `"stream-online" (videoId, liveChatId,
 * concurrentViewers?, startedAt?)` / `"stream-offline"` on `youtubeChatEvents`
 * (contracts.ts), then the `EventManager` trigger via triggers/stream-events.
 *
 * Robustness: API errors never crash the poll — `auth`/`quota`/`rate-limit`
 * are logged at warn and retried next tick; three consecutive kind:"other" /
 * network failures back the cadence off to 5 minutes until a success.
 *
 * NOTE on multi-broadcast selection: the to-do wanted "most recent by
 * snippet.publishedAt", but the WS-1 contract (`contracts.ts`, source of
 * truth) does not map `publishedAt` onto `YouTubeBroadcast` — for a live
 * broadcast `actualStartTime` (falling back to `scheduledStartTime`) is the
 * natural recency key, so the most recently *started* live broadcast wins.
 */
class YouTubeLiveMonitor {
    private _running = false;
    private _timer: ReturnType<typeof setTimeout> | null = null;
    private _current: YouTubeLiveState | null = null;
    private _consecutiveOtherFailures = 0;
    private _backingOff = false;
    private _lastPayloadSent: string | null = null;

    /** Begin polling (idempotent). No-op without a linked streamer account. */
    start(): void {
        if (this._running) {
            return;
        }
        if (youtubeAccountStore.getRawAccount("streamer") == null) {
            logger.info("YouTube live monitor not started: no streamer account is linked.");
            return;
        }

        logger.info("YouTube live monitor started (60s live-check poll).");
        this._running = true;
        this._consecutiveOtherFailures = 0;
        this._backingOff = false;
        this._lastPayloadSent = null;

        // Immediate first pass so a stream already live at connect is detected
        // right away; the chained timeout takes over from there.
        void this._tick();
    }

    /** Stop polling and clear all cached state (idempotent, safe mid-tick). */
    stop(): void {
        if (this._timer != null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._running = false;
        this._current = null;
        this._consecutiveOtherFailures = 0;
        this._backingOff = false;

        // Final teardown send so the dashboard clears its stream info. Only
        // sent when an update was actually delivered during this session.
        if (this._lastPayloadSent != null) {
            this._lastPayloadSent = null;
            frontendCommunicator.send("youtube:stream-info-update", this._buildPayload(false, false, null));
        }
    }

    isRunning(): boolean {
        return this._running;
    }

    /** The broadcast currently tracked as live (null while offline). */
    getCurrentLive(): YouTubeLiveState | null {
        return this._current;
    }

    private async _tick(): Promise<void> {
        if (!this._running) {
            return;
        }

        try {
            await this._pollOnce();
            this._recoverFromBackoff();
        } catch (error) {
            this._handlePollError(error);
        } finally {
            // stop() may have been called while awaiting the API calls.
            if (this._running) {
                this._scheduleNextTick();
            }
        }
    }

    private async _pollOnce(): Promise<void> {
        // Throws (YouTubeApiError) up to _tick for failure accounting; the
        // chained timer keeps running either way.
        const broadcasts = await youTubeApiClient.listOwnBroadcasts("streamer");
        const preLive = broadcasts.some(broadcast => broadcast.lifeCycleStatus === "testStarting");
        const liveBroadcast = this._pickLiveBroadcast(broadcasts);

        if (liveBroadcast == null) {
            if (this._current != null) {
                this._transitionToOffline(
                    `broadcast left the live list (expected "complete"; was "${this._current.videoId}")`
                );
                return;
            }

            this._sendInfoUpdate(this._buildPayload(true, preLive, null));
            return;
        }

        if (this._current != null && this._current.videoId === liveBroadcast.id) {
            // Same broadcast — piggyback a details refresh on this tick.
            const details = await this._fetchLiveDetails(liveBroadcast.id);
            this._current = {
                videoId: liveBroadcast.id,
                liveChatId: this._current.liveChatId ?? details?.liveChatId ?? null,
                title: liveBroadcast.title,
                concurrentViewers: parseCount(details?.concurrentViewers),
                totalViewCount: parseCount(details?.totalViewCount),
                // Never regress: keep the original startedAt once known.
                startedAt: this._current.startedAt ?? liveBroadcast.actualStartTime ?? details?.actualStartTime ?? null
            };
            this._sendInfoUpdate(this._buildPayload(true, false, this._current));
            return;
        }

        if (this._current != null) {
            // A different broadcast is live — the old one ended abruptly.
            this._transitionToOffline(`superseded by another broadcast (now "${liveBroadcast.id}")`);
        }

        const details = await this._fetchLiveDetails(liveBroadcast.id);
        this._transitionToLive(liveBroadcast, details);
    }

    private _scheduleNextTick(): void {
        const delay = this._backingOff ? BACKOFF_INTERVAL_MS : POLL_INTERVAL_MS;
        const timer = setTimeout(() => {
            void this._tick();
        }, delay);
        // Never hold the process open on a pending poll (keeps non-Electron
        // contexts like jest workers from hanging).
        timer.unref?.();
        this._timer = timer;
    }

    private _handlePollError(error: unknown): void {
        const kind = error instanceof YouTubeApiError ? error.kind : "other";
        const message = error instanceof Error ? error.message : String(error);

        if (kind === "other") {
            this._consecutiveOtherFailures += 1;
            if (this._consecutiveOtherFailures >= CONSECUTIVE_FAILURE_BACKOFF_THRESHOLD) {
                if (!this._backingOff) {
                    this._backingOff = true;
                    logger.warn(
                        `YouTube live monitor: ${this._consecutiveOtherFailures} consecutive failures — backing off to ${BACKOFF_INTERVAL_MS / 1000}s cadence until the next success.`
                    );
                }
            }
        }

        logger.warn(`YouTube live monitor: poll failed (kind=${kind}): ${message}`);
    }

    private _recoverFromBackoff(): void {
        if (this._backingOff) {
            this._backingOff = false;
            this._consecutiveOtherFailures = 0;
            logger.info("YouTube live monitor: recovered — poll cadence back to 60s.");
        }
    }

    /**
     * Among `lifeCycleStatus === "live"` broadcasts, the most recently started
     * one wins (recency key: actualStartTime ?? scheduledStartTime — see the
     * class doc note about `publishedAt`).
     */
    private _pickLiveBroadcast(broadcasts: YouTubeBroadcast[]): YouTubeBroadcast | null {
        const live = broadcasts.filter(broadcast => broadcast.lifeCycleStatus === "live");
        if (live.length === 0) {
            return null;
        }
        if (live.length === 1) {
            return live[0];
        }

        live.sort((a, b) => broadcastRecencyMs(b) - broadcastRecencyMs(a));
        return live[0];
    }

    private async _fetchLiveDetails(videoId: string): Promise<YouTubeVideoLiveDetails | null> {
        try {
            return await youTubeApiClient.getVideoLiveDetails("streamer", videoId);
        } catch (error) {
            // Viewer telemetry must never take down the live state machine.
            const kind = error instanceof YouTubeApiError ? error.kind : "other";
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`YouTube live monitor: getVideoLiveDetails(${videoId}) failed (kind=${kind}): ${message}`);
            return null;
        }
    }

    private _transitionToLive(broadcast: YouTubeBroadcast, details: YouTubeVideoLiveDetails | null): void {
        const liveChatId = broadcast.liveChatId ?? details?.liveChatId ?? null;

        this._current = {
            videoId: broadcast.id,
            liveChatId,
            title: broadcast.title,
            concurrentViewers: parseCount(details?.concurrentViewers),
            totalViewCount: parseCount(details?.totalViewCount),
            startedAt: broadcast.actualStartTime ?? details?.actualStartTime ?? null
        };

        logger.info(
            `YouTube stream is LIVE: "${broadcast.title}" (videoId=${broadcast.id}, liveChatId=${liveChatId ?? "<none>"})`
        );

        if (liveChatId == null) {
            logger.warn(
                `YouTube stream is live but no liveChatId was returned; the chat reader cannot start (videoId=${broadcast.id}).`
            );
        }

        // WS-4 hook FIRST, then the announcements — subscribers can assume the
        // reader is wired before they observe the event.
        if (liveChatId != null) {
            startChatIngest(liveChatId, broadcast.id);
        }

        youtubeChatEvents.emit("stream-online", broadcast.id, liveChatId ?? "", parseCount(details?.concurrentViewers) ?? undefined, this._current.startedAt ?? undefined);
        triggerStreamOnline(this._streamerChannel(), {
            videoId: broadcast.id,
            liveChatId,
            concurrentViewers: this._current.concurrentViewers,
            startedAt: this._current.startedAt
        });

        this._sendInfoUpdate(this._buildPayload(true, false, this._current));
    }

    private _transitionToOffline(reason: string): void {
        const previous = this._current;
        this._current = null;

        logger.info(`YouTube stream is OFFLINE (videoId=${previous?.videoId ?? "unknown"}): ${reason}`);

        stopChatIngest();
        youtubeChatEvents.emit("stream-offline");
        triggerStreamOffline(this._streamerChannel());

        this._sendInfoUpdate(this._buildPayload(true, false, null));
    }

    private _buildPayload(connected: boolean, preLive: boolean, current: YouTubeLiveState | null): YouTubeStreamInfoUpdate {
        return {
            connected,
            live: current != null,
            preLive: preLive && current == null,
            videoId: current?.videoId ?? null,
            title: current?.title ?? null,
            liveChatId: current?.liveChatId ?? null,
            concurrentViewers: current?.concurrentViewers ?? null,
            totalViewCount: current?.totalViewCount ?? null,
            startedAt: current?.startedAt ?? null
        };
    }

    private _sendInfoUpdate(payload: YouTubeStreamInfoUpdate): void {
        const serialized = JSON.stringify(payload);
        if (serialized === this._lastPayloadSent) {
            return;
        }
        this._lastPayloadSent = serialized;
        frontendCommunicator.send("youtube:stream-info-update", payload);
    }

    // No cached streamer channel can happen right after a degraded connect
    // (channel fetch failed); events still fire, with empty user metadata.
    private _streamerChannel(): { channelId: string; channelTitle: string } {
        const channel = youtubeAccountStore.getStreamerAccount()?.channel;
        if (channel == null) {
            logger.warn("YouTube no streamer channel is cached; stream events fire with empty user metadata.");
            return { channelId: "", channelTitle: "" };
        }
        return channel;
    }
}

function broadcastRecencyMs(broadcast: YouTubeBroadcast): number {
    const raw = broadcast.actualStartTime ?? broadcast.scheduledStartTime;
    const time = raw != null ? new Date(raw).getTime() : NaN;
    return Number.isNaN(time) ? 0 : time;
}

/** "1337" → 1337; anything else (missing, negative, non-numeric) → null. */
function parseCount(raw: string | null | undefined): number | null {
    if (raw == null) {
        return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export const youtubeLiveMonitor = new YouTubeLiveMonitor();

export { YouTubeLiveMonitor };
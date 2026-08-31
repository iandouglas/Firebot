import { FrontendChatManager } from "../../../chat/frontend-chat-manager";
import chatCommandHandler from "../../../chat/commands/chat-command-handler";
import { ActiveUserHandler } from "../../../chat/active-user-handler";
import { AccountAccess } from "../../../common/account-access";
import { LoggerCache } from "../../../logger-cache";
import viewerDatabase from "../../../viewers/viewer-database";
import viewerOnlineStatusManager from "../../../viewers/viewer-online-status-manager";
import { scopeViewerId } from "../../../viewers/viewer-identity";

import { youtubeAccountStore } from "./account-store";
import {
    YouTubeApiError,
    youtubeChatEvents,
    type YouTubeChatMessageItem,
    type YouTubeChatMessageList,
    type YouTubeIngestMessage
} from "./contracts";
import { ingestMessageToFirebotChatMessage, mapChatItemToIngestMessage } from "./chat-message-mapper";
import { triggerMembersOnlyMode } from "./events/event-handler";
import { youTubeApiClient } from "./youtube-api-client";

const logger = LoggerCache.getLogger("YouTube");

/**
 * WS-4 — YouTube live-chat reader.
 *
 * The live monitor (WS-2) drives this module's lifecycle through the two
 * LOCKED exported signatures (asserted by its tests):
 *
 *   - `startChatIngest(liveChatId, videoId)` — once per broadcast going live.
 *   - `stopChatIngest()` — on every offline transition; idempotent.
 *
 * ## Reader loop (invariants #3, #4, #6)
 * Polls `youTubeApiClient.listChatMessages("streamer", liveChatId, pageToken)`
 * and waits each response's `pollingIntervalMillis` (fallback 5000 ms when the
 * response has no usable value) before the next call. Items are deduped by
 * message id in an in-memory LRU; the `nextPageToken` cursor is memory-only
 * per session, so a restart resumes history-free at the newest page and the
 * LRU swallows any overlap.
 *
 * ## Routing (per deduped item)
 * 1. Normalize via `mapChatItemToIngestMessage` and emit on
 *    `youtubeChatEvents` "chat-message" (text AND non-text kinds — WS-7
 *    subscribes and maps them to events).
 * 2. sponsorOnlyMode* channel modes (no ingest kind exists) → call WS-7's
 *    `triggerMembersOnlyMode()` directly with the streamer channel context.
 * 3. `chatEndedEvent` items → clean stop + emit "stream-offline" (matches
 *    WS-2's offline telemetry; the monitor's own next tick will see the
 *    transition and re-emit once — expected, not a bug).
 * 4. `text` kinds additionally route to:
 *    - `FrontendChatManager.sendChatMessageToFrontend` (blended dashboard
 *      feed; own-account messages included — they ARE the streamer's voice),
 *    - `ActiveUserHandler.addYouTubeActiveUser` (Chat Users panel presence,
 *      platform-tagged),
 *    - the viewer-DB path (throttled `upsertYouTubeViewer` + chat-message
 *      increment, all scoped to `youtube:` — invariant #1),
 *    - `chatCommandHandler.handleChatMessage` — SKIPPED for any of the four
 *      logged-in identities (invariant #2): Twitch streamer/bot by username
 *      (AccountAccess) and YT streamer/bot by raw channel id (account store).
 *      Custom commands default `ignoreStreamer`/`ignoreBot` OFF, and the
 *      Twitch-side name match can't cover YT channel ids, so the ingest-side
 *      self-filter is the enforcement point. Feed, presence, and viewer
 *      accrual still include own-account messages.
 *
 * ## Terminal + transient behavior (invariant #4)
 * - `offlineAt` in a response / `chatEndedEvent` item / `chat-ended` API
 *   error → clean stop + "stream-offline".
 * - `auth`/`quota`/`not-found` → stop without emitting (the monitor owns
 *   stream-state announcements; the reader has nothing to recover from).
 * - `rate-limit` / 5xx / network → exponential backoff (2 s, 4 s, 8 s) for up
 *   to 3 rapid attempts, then fall back to the monitor's 60 s cadence with a
 *   fresh page token (gap logged). The monitor does NOT re-call
 *   `startChatIngest` while a broadcast stays live, so the reader must
 *   self-heal — a transient-network reader that gave up permanently would be
 *   dead for the rest of the stream.
 */

const DEFAULT_POLL_INTERVAL_MS = 5000;
const RAPID_BACKOFF_BASE_MS = 2000;
const MAX_RAPID_TRANSIENT_ATTEMPTS = 3;
const MONITOR_CADENCE_MS = 60 * 1000;
const DEDUPE_CACHE_LIMIT = 2048;
const VIEWER_UPSERT_THROTTLE_MS = 60 * 1000;

interface ChatIngestState {
    liveChatId: string;
    videoId: string;
    nextPageToken?: string;
    timer: ReturnType<typeof setTimeout> | null;
    terminal: boolean;
    consecutiveTransientFailures: number;
}

interface SelfAuthorIndex {
    /** Raw YouTube channel ids owned by this Firebot (streamer or bot). */
    youtubeChannelIds: Set<string>;
    /** Lowercased Twitch usernames owned by this Firebot (streamer or bot). */
    twitchUsernames: Set<string>;
}

let currentRun: ChatIngestState | null = null;
let cachedSelfIndex: SelfAuthorIndex | null = null;

/** In-memory message-id LRU (Map preserves insertion order; oldest falls off first). */
const seenMessageIds = new Map<string, true>();

/** channelId → epoch ms of the last viewer-DB upsert for that user (throttle map). */
const lastViewerUpsertAt = new Map<string, number>();

function buildSelfAuthorIndex(): SelfAuthorIndex {
    const youtubeChannelIds = new Set<string>();
    const twitchUsernames = new Set<string>();

    for (const account of ["streamer", "bot"] as const) {
        const raw = youtubeAccountStore.getRawAccount(account);
        if (raw?.channel?.channelId) {
            youtubeChannelIds.add(raw.channel.channelId);
        }
        if (raw?.channel?.channelTitle) {
            // The YT streamer's channel title also matches their own Twitch
            // username in the common "Same Display Name" case. This does NOT
            // make a coincidentally-same-displayed YT viewer self.
            twitchUsernames.add(raw.channel.channelTitle.toLowerCase());
        }
    }

    const accounts = AccountAccess.getAccounts();
    if (accounts?.streamer?.username) {
        twitchUsernames.add(accounts.streamer.username.toLowerCase());
    }
    if (accounts?.bot?.username) {
        twitchUsernames.add(accounts.bot.username.toLowerCase());
    }

    return { youtubeChannelIds, twitchUsernames };
}

function getSelfAuthorIndex(): SelfAuthorIndex {
    if (cachedSelfIndex == null) {
        cachedSelfIndex = buildSelfAuthorIndex();
    }
    return cachedSelfIndex;
}

function isSelfAuthor(channelId: string | undefined, username: string | undefined): boolean {
    if (channelId && getSelfAuthorIndex().youtubeChannelIds.has(channelId)) {
        return true;
    }
    const normalizedName = (username ?? "").toLowerCase();
    return normalizedName !== "" && getSelfAuthorIndex().twitchUsernames.has(normalizedName);
}

function getStreamerChannelContext(): { channelId?: string; channelTitle?: string } {
    const channel = youtubeAccountStore.getStreamerAccount()?.channel;
    if (channel == null) {
        return {};
    }
    return { channelId: channel.channelId, channelTitle: channel.channelTitle };
}

function resolvePollingInterval(list: YouTubeChatMessageList): number {
    const requested = list.pollingIntervalMillis;
    return typeof requested === "number" && Number.isFinite(requested) && requested > 0
        ? requested
        : DEFAULT_POLL_INTERVAL_MS;
}

function isSeen(messageId: string): boolean {
    return seenMessageIds.has(messageId);
}

function registerSeen(messageId: string): void {
    if (seenMessageIds.size >= DEDUPE_CACHE_LIMIT) {
        const oldest = seenMessageIds.keys().next().value;
        if (oldest != null) {
            seenMessageIds.delete(oldest);
        }
    }
    seenMessageIds.set(messageId, true);
}

async function accrueViewerStats(ingest: YouTubeIngestMessage, username: string): Promise<void> {
    const channelId = ingest.author?.channelId;
    if (typeof channelId !== "string" || channelId === "") {
        return;
    }

    try {
        if (viewerDatabase.isViewerDBOn() !== true) {
            return;
        }

        const now = Date.now();
        const last = lastViewerUpsertAt.get(channelId) ?? 0;
        const needsUpsert = now - last >= VIEWER_UPSERT_THROTTLE_MS;

        if (needsUpsert) {
            const viewer = await viewerDatabase.upsertYouTubeViewer(channelId, {
                displayName: ingest.author.displayName,
                username,
                avatarUrl: ingest.author.avatarUrl
            });
            lastViewerUpsertAt.set(channelId, now);

            // The scoped `youtube:<id>` record exists now. Flag the chatter
            // online so the platform-wide view-time accrual timer reaches them
            // (viewer-online-status-manager owns the online-flag math).
            if (viewer != null) {
                await viewerOnlineStatusManager.setChatViewerOnline({
                    id: channelId,
                    username,
                    displayName: ingest.author.displayName,
                    twitchRoles: [],
                    profilePicUrl: ingest.author.avatarUrl
                });
            }
        }

        // Chat-message accrual applies every time, throttled or not.
        await viewerDatabase.incrementDbField(scopeViewerId("youtube", channelId), "chatMessages");
    } catch (error) {
        logger.warn(`YouTube chat ingest: viewer-DB accrual failed for ${channelId}:`, error);
    }
}

function handleTextMessage(ingest: YouTubeIngestMessage): void {
    const firebotMessage = ingestMessageToFirebotChatMessage(ingest, {
        selfDisplayName: getStreamerChannelContext().channelTitle
    });

    // 1) Blended dashboard feed — own-account messages included (blended chat).
    if (firebotMessage != null) {
        try {
            FrontendChatManager.sendChatMessageToFrontend(firebotMessage);
        } catch (error) {
            logger.warn("YouTube chat ingest: sending message to the frontend failed:", error);
        }
    }

    if (firebotMessage == null) {
        return;
    }

    const self = isSelfAuthor(firebotMessage.userId, firebotMessage.username);

    // 2) Presence — Chat Users panel (platform-tagged). Own messages included
    //    for parity with Twitch's addActiveUser for streamer/bot messages.
    void (async () => {
        try {
            await ActiveUserHandler.addYouTubeActiveUser({
                id: ingest.author.channelId,
                username: firebotMessage.username,
                displayName: ingest.author.displayName,
                profilePicUrl: ingest.author.avatarUrl,
                roles: firebotMessage.roles
            });
        } catch (error) {
            logger.warn("YouTube chat ingest: presence registration failed:", error);
        }
    })();

    // 3) Viewer-DB accrual (throttled upsert + chat-message count).
    void (async () => {
        await accrueViewerStats(ingest, firebotMessage.username);
    })();

    // 4) Command processing — SKIP for any of the four logged-in identities.
    if (!self) {
        void (async () => {
            try {
                await chatCommandHandler.handleChatMessage(firebotMessage);
            } catch (error) {
                logger.warn("YouTube chat ingest: command handling failed:", error);
            }
        })();
    }
}

function processChatItem(run: ChatIngestState, item: YouTubeChatMessageItem | undefined): void {
    const messageId = item?.id;
    if (typeof messageId !== "string" || messageId === "") {
        return;
    }

    if (isSeen(messageId)) {
        return;
    }
    registerSeen(messageId);

    const mapped = mapChatItemToIngestMessage(item);

    if (mapped.membersOnlyMode != null) {
        triggerMembersOnlyMode(mapped.membersOnlyMode === "started", getStreamerChannelContext());
        return;
    }

    if (mapped.message != null) {
        const self = isSelfAuthor(
            mapped.message.author?.channelId,
            mapped.message.author?.displayName
        );

        // The ingest bus carries every normalized message (WS-7 event parity;
        // WS-6 relay self-filters independently per invariant #2). Feed +
        // presence + viewer accrual also include own-account messages (blended
        // chat parity with Twitch) — ONLY command processing is self-gated
        // inside handleTextMessage.
        if (self && mapped.message.kind === "text") {
            logger.debug(`YouTube chat ingest: self-authored text ${messageId}; command processing will be skipped.`);
        }

        youtubeChatEvents.emit("chat-message", mapped.message);

        if (mapped.message.kind === "text") {
            handleTextMessage(mapped.message);
        }
        return;
    }

    if (mapped.chatEnded) {
        endForStreamOffline(run, "chat-ended signal in chat list response");
    }
}

function processList(run: ChatIngestState, list: YouTubeChatMessageList): void {
    for (const item of list.messages ?? []) {
        processChatItem(run, item);
        if (currentRun !== run || run.terminal) {
            return;
        }
    }
}

/**
 * One poll step: fetch a page, hand items through the pipeline, chain the
 * cursor, resolve the next delay. Returns null when the loop must NOT
 * continue (stopped or terminal).
 */
async function pollStep(run: ChatIngestState): Promise<number | null> {
    let delayMs: number;
    try {
        const list = await youTubeApiClient.listChatMessages(
            "streamer",
            run.liveChatId,
            run.nextPageToken
        );
        if (currentRun !== run || run.terminal) {
            return null;
        }

        run.consecutiveTransientFailures = 0;
        processList(run, list);
        if (currentRun !== run || run.terminal) {
            return null;
        }

        if (list.offlineAt != null) {
            endForStreamOffline(run, "offlineAt in chat list response");
            return null;
        }

        if (list.nextPageToken != null) {
            run.nextPageToken = list.nextPageToken;
        }
        delayMs = resolvePollingInterval(list);
    } catch (error) {
        if (currentRun !== run || run.terminal) {
            return null;
        }
        const nextDelay = handlePollError(run, error);
        if (nextDelay == null) {
            return null;
        }
        delayMs = nextDelay;
    }

    return delayMs;
}

function scheduleNextPoll(run: ChatIngestState, delayMs: number): void {
    if (currentRun !== run || run.terminal) {
        return;
    }
    const timer = setTimeout(() => {
        // pollStep returns the next delay (or null to stop); chain it so the
        // reader self-schedules until a terminal/stop condition is reached.
        void pollStep(run).then((nextDelay) => {
            if (nextDelay != null) {
                scheduleNextPoll(run, nextDelay);
            }
        });
    }, delayMs);
    timer.unref?.();
    run.timer = timer;
}

/** Clears reader state without emitting; idempotent. */
function teardownCurrentRun(): void {
    if (currentRun?.timer != null) {
        clearTimeout(currentRun.timer);
        currentRun.timer = null;
    }
    if (currentRun != null) {
        currentRun.terminal = true;
        currentRun = null;
    }
}

function endForStreamOffline(run: ChatIngestState, reason: string): void {
    if (run.terminal) {
        return;
    }
    if (currentRun === run && run.timer != null) {
        clearTimeout(run.timer);
        run.timer = null;
    }
    run.terminal = true;
    if (currentRun === run) {
        currentRun = null;
    }

    logger.info(`YouTube chat reader stopped: ${reason} (videoId=${run.videoId}).`);
    // Consistency with WS-2's own offline transition telemetry.
    youtubeChatEvents.emit("stream-offline");
}

/**
 * Error taxonomy for one failed poll (invariant #4). Returns the delay before
 * the next attempt, or null when the loop stops.
 */
function handlePollError(run: ChatIngestState, error: unknown): number | null {
    const kind = error instanceof YouTubeApiError ? error.kind : "other";
    const message = error instanceof Error ? error.message : String(error);

    switch (kind) {
        case "chat-ended":
            endForStreamOffline(run, `liveChatEnded API error: ${message}`);
            return null;

        case "auth":
        case "quota":
        case "not-found":
            logger.warn(`YouTube chat reader stopped (kind=${kind}): ${message}`);
            teardownCurrentRun();
            return null;

        // "rate-limit" and "other" (network / 5xx) are transient.
        default: {
            const nextStreak = run.consecutiveTransientFailures + 1;
            if (nextStreak >= MAX_RAPID_TRANSIENT_ATTEMPTS) {
                run.consecutiveTransientFailures = 0;
                run.nextPageToken = undefined;
                logger.warn(
                    `YouTube chat reader: ${nextStreak} consecutive transient poll failures — backing off to a ${MONITOR_CADENCE_MS / 1000}s cadence and resuming with a fresh page token (recent messages during the gap may be skipped). Last error (kind=${kind}): ${message}`
                );
                return MONITOR_CADENCE_MS;
            }
            run.consecutiveTransientFailures = nextStreak;
            const delayMs = RAPID_BACKOFF_BASE_MS * Math.pow(2, nextStreak - 1);
            logger.warn(
                `YouTube chat reader: poll failed (kind=${kind}), rapid retry ${nextStreak}/${MAX_RAPID_TRANSIENT_ATTEMPTS} in ${delayMs / 1000}s: ${message}`
            );
            return delayMs;
        }
    }
}

/**
 * LOCKED SIGNATURE (WS-2 handoff; asserted by its tests): begins the chat
 * read loop for a broadcast the monitor considers live. Calling again with
 * the SAME broadcast while already running is a no-op; a different liveChatId
 * replaces the loop cleanly (previous cursor discarded).
 */
export function startChatIngest(liveChatId: string, videoId: string): void {
    if (typeof liveChatId !== "string" || liveChatId.trim() === "") {
        logger.warn("YouTube chat ingest not started: liveChatId is missing.");
        return;
    }
    if (typeof videoId !== "string" || videoId.trim() === "") {
        logger.warn("YouTube chat ingest not started: videoId is missing.");
        return;
    }

    if (currentRun != null && !currentRun.terminal
        && currentRun.liveChatId === liveChatId
        && currentRun.videoId === videoId) {
        // Idempotent — the same broadcast is already being read.
        return;
    }

    teardownCurrentRun();
    cachedSelfIndex = null;

    const run: ChatIngestState = {
        liveChatId,
        videoId,
        timer: null,
        terminal: false,
        consecutiveTransientFailures: 0
    };
    currentRun = run;

    logger.info(`YouTube chat ingest started (videoId=${videoId}, liveChatId=${liveChatId}).`);
    scheduleNextPoll(run, 0);
}

/**
 * LOCKED SIGNATURE (WS-2 handoff): stops the reader, clears timers + the page
 * cursor, and is safe to call repeatedly or when nothing is running.
 */
export function stopChatIngest(): void {
    teardownCurrentRun();
    cachedSelfIndex = null;
}

/** True while a reader is active (for tests/observability; the monitor owns the lifecycle). */
export function isChatIngestRunning(liveChatId?: string): boolean {
    if (currentRun == null || currentRun.terminal) {
        return false;
    }
    return liveChatId == null || currentRun.liveChatId === liveChatId;
}
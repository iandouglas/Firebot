/**
 * WS-2 THIN STUB — the real implementation is owned by WS-4 (chat ingest:
 * read loop → commands + merged feed + roles).
 *
 * The live monitor (live-monitor.ts) drives the chat reader lifecycle through
 * these two functions, wired at its online/offline transitions:
 *
 *   - `startChatIngest` is called exactly once per broadcast going live.
 *   - `stopChatIngest` is called on every offline transition (broadcast
 *     complete / replaced by another broadcast / monitor stopped) and is
 *     safe to call when nothing is running.
 *
 * ## WS-4 expectations (from to-do.md — keep these signatures EXACTLY)
 *
 * WS-4 must flesh out the bodies of these functions WITHOUT changing the
 * exported signatures, so the live monitor wiring and its tests keep working:
 *
 * - `startChatIngest(liveChatId, videoId)`:
 *   - paginate `youTubeApiClient.listChatMessages("streamer", liveChatId, pageToken?)`
 *     respecting the per-response `pollingIntervalMillis`
 *     (core invariant #4: read loop starts ONLY while the broadcast is live);
 *   - dedupe by `messageId` (in-memory LRU; restart-safe thanks to `nextPageToken`,
 *     invariant #6: token in memory only, restart history-free with `maxResults=200`);
 *   - normalize every item to `YouTubeIngestMessage` and emit "chat-message"
 *     on `youtubeChatEvents`, hand off non-text kinds to the WS-7 emitter;
 *   - route text messages through `chatCommandHandler.handleChatMessage` while
 *     filtering the four logged-in identities (loop prevention, invariant #2);
 *   - on a `chat-ended` / `offlineAt` signal: clean stop + fire "stream-offline"
 *     via `youtubeChatEvents` (WS-2 emits the same transition from lifeCycleStatus);
 *   - exponential backoff (max 3) on 5xx/network errors before giving up until
 *     the next live-check (invariant #4);
 *   - a call while already running must restart the reader cleanly (new
 *     `liveChatId` replaces the old loop, old timer/pagination token discarded).
 * - `stopChatIngest()`:
 *   - stop the read loop, clear timers + page token, no unhandled rejections;
 *   - MUST be idempotent (monitor may call it when no reader is running).
 */

// TODO(WS-4): replace the no-op bodies with the real reader loop. The live
// monitor and its tests depend on BOTH signatures below staying exactly as
// documented — do not add parameters, rename, or change return types.

export function startChatIngest(_liveChatId: string, _videoId: string): void {
    // WS-2 stub: intentionally a no-op until WS-4 lands.
}

export function stopChatIngest(): void {
    // WS-2 stub: intentionally a no-op until WS-4 lands.
}
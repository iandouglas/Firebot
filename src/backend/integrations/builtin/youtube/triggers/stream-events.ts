import { EventManager } from "../../../../events/event-manager";

/**
 * WS-2 stream lifecycle events for the "youtube" event source.
 *
 * Event IDs are `youtube:*` (locked decision D8 — never reuse `twitch:*`).
 * The event SOURCE definitions for these ids live in the youtube `events/`
 * directory and are owned by WS-7 — this module only *fires* them.
 *
 * Metadata contract (per to-do.md WS-2), aligned with the twitch equivalents
 * in `streaming-platforms/twitch/events/stream.ts`:
 *   - `username`        channel title of the linked streamer account
 *   - `userId`          raw platform channel id (UC...) — invariant #1
 *   - `userDisplayName` same as `username` (channels don't have login names)
 * and, for `stream-online` only, the stream context fields below.
 */

export interface YouTubeStreamContext {
    videoId: string;
    liveChatId: string | null;
    /** Parsed viewer count; null when the API returned nothing parseable. */
    concurrentViewers: number | null;
    /** ISO timestamp the broadcast actually went live (actualStartTime). */
    startedAt: string | null;
}

export function triggerStreamOnline(channel: { channelId: string; channelTitle: string }, stream: YouTubeStreamContext): void {
    void EventManager.triggerEvent("youtube", "stream-online", {
        username: channel.channelTitle,
        userId: channel.channelId,
        userDisplayName: channel.channelTitle,
        videoId: stream.videoId,
        liveChatId: stream.liveChatId,
        concurrentViewers: stream.concurrentViewers,
        startedAt: stream.startedAt
    });
}

export function triggerStreamOffline(channel: { channelId: string; channelTitle: string }): void {
    void EventManager.triggerEvent("youtube", "stream-offline", {
        username: channel.channelTitle,
        userId: channel.channelId,
        userDisplayName: channel.channelTitle
    });
}
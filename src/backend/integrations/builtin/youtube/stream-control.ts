import { LoggerCache } from "../../../logger-cache";

import { youTubeApiClient } from "./youtube-api-client";
import { youtubeChatEvents, YouTubeApiError } from "./contracts";

const logger = LoggerCache.getLogger("YouTube");

/**
 * WS-8 — YouTube stream control (title updates).
 *
 * Tracks the active broadcast's video id by listening to the shared
 * "stream-online" / "stream-offline" events (WS-2 emits them). Title updates
 * only succeed while a broadcast is live, so state is held here rather than by
 * callers.
 *
 * The `stream-title` effect (Twitch effects) routes its YouTube destination
 * through {@link youTubeStreamControl.updateTitle}. This module never throws —
 * failures are returned in a result object.
 */
export interface YouTubeStreamControlResult {
    success: boolean;
    error?: string;
}

export class YouTubeStreamControl {
    private _videoId: string | null = null;
    private _apiClient: Pick<typeof youTubeApiClient, "updateBroadcastTitle">;

    constructor() {
        this._apiClient = youTubeApiClient;

        youtubeChatEvents.on("stream-online", (videoId: string) => {
            if (videoId == null || videoId === "") {
                logger.warn("YouTube stream went online without a video id; title updates disabled.");
                this._videoId = null;
                return;
            }
            this._videoId = videoId;
            logger.debug(`YouTube stream online; title updates targeting video ${videoId}`);
        });

        youtubeChatEvents.on("stream-offline", () => {
            if (this._videoId != null) {
                logger.debug("YouTube stream offline; title updates disabled until the next live broadcast.");
            }
            this._videoId = null;
        });
    }

    /** True while a video id is cached (i.e. the broadcast is live). */
    isLive(): boolean {
        return this._videoId != null;
    }

    getVideoId(): string | null {
        return this._videoId;
    }

    /**
     * Update the live broadcast's title via `liveBroadcasts.update` (owner
     * token). No-op + warn when the broadcast isn't live.
     */
    async updateTitle(title: string): Promise<YouTubeStreamControlResult> {
        if (title == null || title === "") {
            return { success: false, error: "Missing title." };
        }
        if (this._videoId == null) {
            logger.warn("YouTube title update skipped: no live broadcast (title updates only work while live).");
            return { success: false, error: "YouTube is not live; title not updated." };
        }
        try {
            await this._apiClient.updateBroadcastTitle("streamer", this._videoId, title);
            logger.debug(`YouTube broadcast title updated to "${title}".`);
            return { success: true };
        } catch (error) {
            const message = error instanceof YouTubeApiError
                ? `YouTube title update failed (${error.kind}): ${error.message}`
                : `YouTube title update failed: ${(error as Error)?.message ?? String(error)}`;
            logger.error(message);
            return { success: false, error: message };
        }
    }
}

export const youTubeStreamControl = new YouTubeStreamControl();

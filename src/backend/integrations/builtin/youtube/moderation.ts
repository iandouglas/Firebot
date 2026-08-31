import frontendCommunicator from "../../../common/frontend-communicator";
import { LoggerCache } from "../../../logger-cache";

import { youTubeApiClient } from "./youtube-api-client";
import { youtubeChatEvents, YouTubeApiError } from "./contracts";

const logger = LoggerCache.getLogger("YouTube");

/**
 * WS-8 — YouTube moderation parity (delete / timeout / ban / unban).
 *
 * All moderation actions run against the STREAMER account token: the YouTube
 * Data API requires owner-or-mod OAuth for `liveChatMessages.delete` and
 * `liveChatBans.insert/delete`, and the dashboard only exposes these actions to
 * the streamer anyway (D10).
 *
 * The active live chat id is tracked by listening to the shared
 * "stream-online" / "stream-offline" events (WS-2 emits them) — moderation only
 * works while a broadcast is live, so state is held here rather than by callers.
 *
 * This module is the single owner of the `youtube:delete-message`,
 * `youtube:timeout-user`, `youtube:ban-user` and `youtube:unban-user` frontend
 * channels. It never throws — failures are returned in a result object.
 */

/** YouTube temporary-ban duration clamp (API constraint: 30s–86399s). */
export const MIN_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 86399;

/** Default timeout applied when the frontend doesn't specify a duration. */
export const DEFAULT_TIMEOUT_SECONDS = 300;

export interface YouTubeModerationResult {
    success: boolean;
    error?: string;
}

export class YouTubeModeration {
    private _liveChatId: string | null = null;
    private _apiClient: Pick<typeof youTubeApiClient, "deleteChatMessage" | "banUser" | "unbanUser">;

    constructor() {
        this._apiClient = youTubeApiClient;

        youtubeChatEvents.on("stream-online", (videoId: string, liveChatId?: string) => {
            if (liveChatId == null || liveChatId === "") {
                logger.warn(`YouTube stream went online (${videoId}) without a live chat id; moderation disabled.`);
                this._liveChatId = null;
                return;
            }
            this._liveChatId = liveChatId;
            logger.debug(`YouTube stream online; moderation targeting liveChatId ${liveChatId}`);
        });

        youtubeChatEvents.on("stream-offline", () => {
            if (this._liveChatId != null) {
                logger.debug("YouTube stream offline; moderation disabled until the next live broadcast.");
            }
            this._liveChatId = null;
        });

        // Single owner of these frontend channels (WS-8).
        frontendCommunicator.onAsync("youtube:delete-message", async (data: { messageId?: string }) => {
            if (data?.messageId == null || data.messageId === "") {
                return { success: false, error: "Missing message id." };
            }
            return await this.deleteMessage(data.messageId);
        });

        frontendCommunicator.onAsync("youtube:timeout-user", async (data: { channelId?: string; seconds?: number }) => {
            if (data?.channelId == null || data.channelId === "") {
                return { success: false, error: "Missing channel id." };
            }
            return await this.timeoutUser(data.channelId, data.seconds ?? DEFAULT_TIMEOUT_SECONDS);
        });

        frontendCommunicator.onAsync("youtube:ban-user", async (data: { channelId?: string }) => {
            if (data?.channelId == null || data.channelId === "") {
                return { success: false, error: "Missing channel id." };
            }
            return await this.banUser(data.channelId);
        });

        frontendCommunicator.onAsync("youtube:unban-user", async (data: { channelId?: string }) => {
            if (data?.channelId == null || data.channelId === "") {
                return { success: false, error: "Missing channel id." };
            }
            return await this.unbanUser(data.channelId);
        });
    }

    /** True while a live chat id is cached (i.e. the broadcast is live). */
    isLive(): boolean {
        return this._liveChatId != null;
    }

    getLiveChatId(): string | null {
        return this._liveChatId;
    }

    /**
     * Delete a live chat message (owner/mod OAuth). `messageId` is the raw
     * YouTube liveChatMessages id carried on the FirebotChatMessage.
     */
    async deleteMessage(messageId: string): Promise<YouTubeModerationResult> {
        if (messageId == null || messageId === "") {
            return { success: false, error: "Missing message id." };
        }
        try {
            await this._apiClient.deleteChatMessage("streamer", messageId);
            logger.debug(`YouTube chat message ${messageId} deleted.`);
            return { success: true };
        } catch (error) {
            return this._error("delete", error);
        }
    }

    /**
     * Timeout a user for `seconds` (clamped to the YouTube 30s–86399s range).
     * `channelId` is the raw YouTube channel id (UC...).
     */
    async timeoutUser(channelId: string, seconds: number): Promise<YouTubeModerationResult> {
        const liveChatId = this._requireLiveChat();
        if (liveChatId == null) {
            return { success: false, error: "YouTube is not live; timeout not applied." };
        }
        if (channelId == null || channelId === "") {
            return { success: false, error: "Missing channel id." };
        }
        const clamped = Math.min(Math.max(Math.round(seconds), MIN_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS);
        try {
            await this._apiClient.banUser("streamer", liveChatId, channelId, {
                type: "temporary",
                durationSecs: clamped
            });
            logger.debug(`YouTube user ${channelId} timed out for ${clamped}s.`);
            return { success: true };
        } catch (error) {
            return this._error("timeout", error);
        }
    }

    /** Permanently ban a user (owner/mod OAuth). */
    async banUser(channelId: string): Promise<YouTubeModerationResult> {
        const liveChatId = this._requireLiveChat();
        if (liveChatId == null) {
            return { success: false, error: "YouTube is not live; ban not applied." };
        }
        if (channelId == null || channelId === "") {
            return { success: false, error: "Missing channel id." };
        }
        try {
            await this._apiClient.banUser("streamer", liveChatId, channelId, { type: "permanent" });
            logger.debug(`YouTube user ${channelId} banned.`);
            return { success: true };
        } catch (error) {
            return this._error("ban", error);
        }
    }

    /**
     * Lift a ban/timeout for a user.
     *
     * NOTE (coordination): the foundation api-client's `unbanUser(account,
     * bannedChatId)` deletes a `liveChatBans` resource by its ban-resource id,
     * not by channel id. The YouTube API has no "unban by channel" endpoint, so
     * a fully correct unban needs the ban-resource id captured at ban time (the
     * client's `banUser` currently returns void). Until the api-client exposes
     * that, this passes the channel id through as the resource id — see the
     * WS-8 report for the follow-up.
     */
    async unbanUser(channelId: string): Promise<YouTubeModerationResult> {
        const liveChatId = this._requireLiveChat();
        if (liveChatId == null) {
            return { success: false, error: "YouTube is not live; unban not applied." };
        }
        if (channelId == null || channelId === "") {
            return { success: false, error: "Missing channel id." };
        }
        try {
            await this._apiClient.unbanUser("streamer", channelId);
            logger.debug(`YouTube user ${channelId} unbanned.`);
            return { success: true };
        } catch (error) {
            return this._error("unban", error);
        }
    }

    private _requireLiveChat(): string | null {
        if (this._liveChatId == null) {
            logger.warn("YouTube moderation skipped: no live broadcast (moderation only works while live).");
            return null;
        }
        return this._liveChatId;
    }

    private _error(action: string, error: unknown): YouTubeModerationResult {
        const message = error instanceof YouTubeApiError
            ? `YouTube ${action} failed (${error.kind}): ${error.message}`
            : `YouTube ${action} failed: ${(error as Error)?.message ?? String(error)}`;
        logger.error(message);
        return { success: false, error: message };
    }
}

export const youTubeModeration = new YouTubeModeration();

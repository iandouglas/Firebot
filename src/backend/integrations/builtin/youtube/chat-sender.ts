import frontendCommunicator from "../../../common/frontend-communicator";
import { LoggerCache } from "../../../logger-cache";

import { youtubeAccountStore } from "./account-store";
import { youTubeApiClient } from "./youtube-api-client";
import { youtubeChatEvents, YouTubeApiError, type YouTubeAccountType } from "./contracts";

const logger = LoggerCache.getLogger("YouTube");

/** YouTube caps regular chat display messages at ~200 characters (see to-do.md facts). */
export const MAX_YOUTUBE_CHAT_LENGTH = 200;

/**
 * Core invariant #3: inserts cost ~50 units/call against the project's 10k/day
 * budget. 80 sends/day ≈ 4,000 units of headroom, leaving room for the live
 * poll + chat reader + moderation. Both linked accounts share ONE GCP project
 * quota, so the guard counts every outbound chat insert regardless of which
 * account sends it.
 */
export const DEFAULT_DAILY_SEND_BUDGET = 80;

/** Quota-spending thresholds that get a logged warning, including the final send before the block. */
const QUOTA_WARNING_THRESHOLDS = [50, 75];

/** Serialized sends: YouTube rate-limits bursts of inserts, so space them out. */
const DEFAULT_SEND_GAP_MS = 250;

export type YouTubeSendSkipReason =
    | "not-live"
    | "missing-account"
    | "quota-budget-exhausted";

export interface YouTubeSendOptions {
    /**
     * Chatter preference carried over from Twitch-style callers:
     * "Bot" | "Streamer" | "Both" (case-insensitive). Unset/"both" resolves to
     * the YouTube bot account when linked, falling back to the streamer account.
     */
    accountType?: string | null;
}

export interface YouTubeSendResult {
    success: boolean;
    /** Non-throwing reason nothing was sent (platform/account state). */
    skipped?: YouTubeSendSkipReason;
    /** Error message when the insert attempt itself failed. */
    error?: string;
    messageId?: string;
    /** The account the (attempted) send used or would have used. */
    account?: YouTubeAccountType;
}

export interface YouTubeChatSenderOptions {
    sendGapMs?: number;
    dailySendBudget?: number;
    /** Injectable day key (UTC date) so tests can simulate day rollovers. */
    getDayKey?: () => string;
}

function defaultDayKey(): string {
    return new Date().toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Outbound YouTube live-chat sender (WS-5).
 *
 * Track the active live chat id by listening to the shared "stream-online" /
 * "stream-offline" events (WS-2 emits them) — inserts only succeed while a
 * broadcast is live, so state is held here rather than by callers.
 *
 * Every send is serialized with a gap between inserts, truncated to YouTube's
 * ~200 char display cap, and gated by a daily quota budget (core invariant #3).
 * This module never throws — failures are returned in the result.
 */
export class YouTubeChatSender {
    private readonly _sendGapMs: number;
    private readonly _getDayKey: () => string;

    private _dailySendBudget: number = DEFAULT_DAILY_SEND_BUDGET;
    private _apiClient: Pick<typeof youTubeApiClient, "insertChatMessage">;

    private _liveChatId: string | null = null;
    private _sendCount = 0;
    private _budgetDayKey: string;
    private _warnedThresholds: Set<number> = new Set();
    private _budgetBlockAnnounced = false;

    /** FIFO promise chain that serializes inserts. */
    private _sendChain: Promise<unknown> = Promise.resolve();
    private _lastSentAt = 0;

    constructor(options: YouTubeChatSenderOptions = {}) {
        this._sendGapMs = options.sendGapMs ?? DEFAULT_SEND_GAP_MS;
        this._getDayKey = options.getDayKey ?? defaultDayKey;
        this._apiClient = youTubeApiClient;
        if (options.dailySendBudget != null) {
            this.setDailySendBudget(options.dailySendBudget);
        }
        this._budgetDayKey = this._getDayKey();

        youtubeChatEvents.on("stream-online", (videoId: string, liveChatId?: string) => {
            if (liveChatId == null || liveChatId === "") {
                logger.warn(`YouTube stream went online (${videoId}) without a live chat id; outbound chat stays disabled.`);
                this._liveChatId = null;
                return;
            }
            this._liveChatId = liveChatId;
            logger.debug(`YouTube stream online; outbound chat targeting liveChatId ${liveChatId}`);
        });

        youtubeChatEvents.on("stream-offline", () => {
            if (this._liveChatId != null) {
                logger.debug("YouTube stream offline; outbound chat disabled until the next live broadcast.");
            }
            this._liveChatId = null;
        });
    }

    /** True while a live chat id is cached (i.e. the broadcast is live). */
    isLive(): boolean {
        return this._liveChatId != null;
    }

    getLiveChatId(): string | null {
        return this._liveChatId;
    }

    getDailySendBudget(): number {
        return this._dailySendBudget;
    }

    /**
     * Adjust the daily outbound-send budget (core invariant #3 default 80;
     * "configurable" per WS-5). Lowering it below the current count blocks
     * sends until the day rolls over.
     */
    setDailySendBudget(budget: number): void {
        const value = Math.max(0, Math.floor(budget));
        if (Number.isNaN(value)) {
            return;
        }
        this._dailySendBudget = value;
    }

    /**
     * Send a chat message to the live YouTube broadcast.
     *
     * Never throws: callers get a {@link YouTubeSendResult} describing what
     * happened. Skipped sends (not live, no account, over budget) are silent
     * on the frontend — only quota-cap blocks escalate to a frontend error.
     */
    async sendChatMessage(text: string, options: YouTubeSendOptions = {}): Promise<YouTubeSendResult> {
        const trimmed = text?.trim?.() ?? "";
        if (trimmed.length < 1) {
            logger.debug("YouTube chat send skipped: empty message.");
            return { success: false };
        }

        if (this._liveChatId == null) {
            logger.debug("YouTube chat send skipped: no live broadcast (outbound chat only works while live).");
            return { success: false, skipped: "not-live" };
        }

        const account = this._resolveAccount(options.accountType);
        if (account == null) {
            logger.debug("YouTube chat send skipped: no linked YouTube account available to send as.");
            return { success: false, skipped: "missing-account" };
        }

        const liveChatId = this._liveChatId;
        const sendText = this._truncateForDisplay(trimmed);

        // Serialize all inserts through the shared chain so we never fire
        // concurrent inserts and always keep a gap between them.
        return await this._enqueue(() => this._attemptInsert(account, liveChatId, sendText));
    }

    /**
     * Resolve which linked YouTube account sends the message.
     *
     * Mirrors the Twitch send fallback: a bot chatter with no linked bot falls
     * back to the streamer account. An explicit streamer request never sends
     * as the bot. `null` = nothing available (caller skips silently).
     */
    private _resolveAccount(accountType?: string | null): YouTubeAccountType | null {
        const requested = (accountType ?? "").trim().toLowerCase();
        const streamerAvailable = youtubeAccountStore.getStreamerAccount() != null;
        const botAvailable = youtubeAccountStore.getBotAccount() != null;

        if (requested === "streamer") {
            return streamerAvailable ? "streamer" : null;
        }

        // "bot" AND the default case ("both"/unset chatter) prefer the bot
        // account when it is linked; otherwise the streamer account sends.
        return botAvailable ? "bot" : streamerAvailable ? "streamer" : null;
    }

    private _truncateForDisplay(text: string): string {
        if (text.length <= MAX_YOUTUBE_CHAT_LENGTH) {
            return text;
        }
        return `${text.slice(0, MAX_YOUTUBE_CHAT_LENGTH - 1)}…`;
    }

    /**
     * Queue an insert task so sends run strictly one-at-a-time with a small
     * delay between them. The queue chain survives task failures.
     */
    private _enqueue<T>(task: () => Promise<T>): Promise<T> {
        const run = this._sendChain.then(async () => {
            const sinceLastSend = Date.now() - this._lastSentAt;
            if (this._sendGapMs > 0 && sinceLastSend < this._sendGapMs) {
                await sleep(this._sendGapMs - sinceLastSend);
            }
            try {
                return await task();
            } finally {
                this._lastSentAt = Date.now();
            }
        });

        this._sendChain = run.then(() => undefined, () => undefined);
        return run;
    }

    private async _attemptInsert(
        account: YouTubeAccountType,
        liveChatId: string,
        text: string
    ): Promise<YouTubeSendResult> {
        if (!this._accountSendAgainstBudget(account)) {
            const message = `Daily YouTube chat send budget exhausted (${this._dailySendBudget}/day); message not sent. Budget resets daily (UTC).`;
            if (!this._budgetBlockAnnounced) {
                this._budgetBlockAnnounced = true;
                frontendCommunicator.send(
                    "error",
                    `YouTube chat sends are capped at ${this._dailySendBudget} per day to protect the YouTube API quota. The following message was NOT sent: "${text}"`
                );
            }
            logger.warn(`YouTube chat send blocked: daily budget exhausted (${this._sendCount}/${this._dailySendBudget} used).`);
            return { success: false, skipped: "quota-budget-exhausted", account };
        }

        try {
            const inserted = await this._apiClient.insertChatMessage(account, liveChatId, text);
            logger.debug(
                `YouTube chat message sent as the '${account}' account (${this._sendCount}/${this._dailySendBudget} of today's send budget used).`
            );
            return { success: true, account, messageId: inserted?.id ?? "" };
        } catch (error) {
            const errorMessage = error instanceof YouTubeApiError
                ? `YouTube chat insert failed (${error.kind}): ${error.message}`
                : `YouTube chat insert failed: ${(error as Error)?.message ?? String(error)}`;
            logger.error(errorMessage);
            return { success: false, account, error: errorMessage };
        }
    }

    /**
     * Daily quota accounting for inserts (core invariant #3). Counts every
     * outbound send (both accounts share the project quota). Returns false
     * when this send is blocked.
     */
    private _accountSendAgainstBudget(account: YouTubeAccountType): boolean {
        this._rollBudgetIfNewDay();

        const nextCount = this._sendCount + 1;
        if (nextCount > this._dailySendBudget) {
            return false;
        }

        this._sendCount = nextCount;

        const thresholds = [
            ...QUOTA_WARNING_THRESHOLDS.filter(value => value < this._dailySendBudget),
            this._dailySendBudget
        ];

        for (const threshold of thresholds) {
            if (nextCount === threshold && !this._warnedThresholds.has(threshold)) {
                this._warnedThresholds.add(threshold);

                if (nextCount === this._dailySendBudget) {
                    logger.warn(
                        `YouTube chat send budget now exhausted: ${nextCount}/${this._dailySendBudget} inserts today. Further sends are blocked until the budget resets.`
                    );
                } else {
                    logger.warn(
                        `YouTube chat sends approaching the daily budget: ${nextCount}/${this._dailySendBudget} inserts used today (${account} account).`
                    );
                }
            }
        }

        return true;
    }

    private _rollBudgetIfNewDay(): void {
        const dayKey = this._getDayKey();
        if (dayKey === this._budgetDayKey) {
            return;
        }
        logger.debug(`YouTube chat send budget rolled over (${this._sendCount} sends used yesterday).`);
        this._budgetDayKey = dayKey;
        this._sendCount = 0;
        this._warnedThresholds = new Set();
        this._budgetBlockAnnounced = false;
    }
}

export const youTubeChatSender = new YouTubeChatSender();
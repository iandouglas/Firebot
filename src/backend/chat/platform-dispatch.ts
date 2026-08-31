import { AccountAccess } from "../common/account-access";
import { youTubeChatSender } from "../integrations/builtin/youtube/chat-sender";
import { TwitchApi } from "../streaming-platforms/twitch/api";
import { LoggerCache } from "../logger-cache";

const logger = LoggerCache.getLogger("Chat");

export type ChatMessageDestination = "both" | "twitch" | "youtube";

export type ChatDispatchSkipReason =
    | "empty-message"
    | "platform-not-connected"
    | "not-live"
    | "missing-account"
    | "quota-budget-exhausted";

export interface ChatDispatchOptions {
    /**
     * Where the message should go. Default `"both"` — locked decision D7.
     */
    destination?: ChatMessageDestination | null;
    /**
     * Chatter preference, carried over from Twitch-style callers
     * (`"Streamer"` | `"Bot"` | `"Both"`, case-insensitive).
     *
     * - `"Bot"` → Twitch sends as the bot account when logged in (falls back to
     *   the streamer account otherwise, matching the historical Twitch behavior);
     *   YouTube uses the linked bot account (falls back to its streamer account).
     * - `"Streamer"` → Twitch sends as the streamer; YouTube uses its streamer
     *   account (skipped silently if that account is missing).
     * - `"Both"`/unset → Twitch sends as the streamer; YouTube picks the bot
     *   account when linked, else its streamer account.
     */
    accountType?: string | null;
    /**
     * Twitch reply threading only. YouTube has no reply-to-message support in
     * v1 — silently ignored for the YouTube side.
     */
    replyToMessageId?: string | null;
}

export interface ChatDispatchPlatformResult {
    /** True when the message was actually handed to the platform's send API. */
    attempted: boolean;
    success: boolean;
    /** Non-throwing reason the platform side was skipped. */
    skipped?: ChatDispatchSkipReason;
    /** Error message when the platform send attempt itself failed. */
    error?: string;
    messageId?: string;
    /** True when Twitch handled the message as a slash command. */
    isSlashCommand?: boolean;
}

export interface ChatDispatchResult {
    twitch: ChatDispatchPlatformResult;
    youtube: ChatDispatchPlatformResult;
}

function normalizeDestination(destination: ChatDispatchOptions["destination"]): ChatMessageDestination {
    const value = (destination ?? "").toString().trim().toLowerCase();
    if (value === "twitch" || value === "youtube") {
        return value;
    }
    return "both";
}

/**
 * Platform-agnostic chat send dispatch (WS-5).
 *
 * The single fan-out point for every dashboard/compose, effect and command
 * response chat send. The Twitch side uses the existing TwitchApi.chat
 * transport; the YouTube side is handled by the YouTube chat sender (which
 * tracks the live chat id, chatter account, serialization and the daily quota
 * budget). Never throws — each side's failure is reported in its result.
 *
 * The `chat:send-chat-message` frontend listener stays in
 * `twitch/api/resource/chat.ts` (single owner, WS-5 constraint) and delegates
 * here; the YouTube module must NOT register its own listener for that event.
 */
class PlatformDispatcher {
    /**
     * Send a chat message to one or both platforms.
     *
     * @returns Per-platform results (`twitch` + `youtube`). WS-6 (relay) and
     * WS-8 (moderation chat confirmations) rely on this exact shape.
     */
    async sendChatMessage(message: string, options: ChatDispatchOptions = {}): Promise<ChatDispatchResult> {
        const result: ChatDispatchResult = {
            twitch: { attempted: false, success: false },
            youtube: { attempted: false, success: false }
        };

        try {
            const destination = normalizeDestination(options.destination);
            const accountType = options.accountType ?? null;

            const trimmed = message?.trim?.() ?? "";
            if (trimmed.length < 1) {
                logger.debug("platform-dispatch: empty chat message; nothing sent.");
                result.twitch.skipped = "empty-message";
                result.youtube.skipped = "empty-message";
                return result;
            }

            // "/me" action messages have no YouTube equivalent — the YouTube
            // side strips the prefix and sends the raw text (WS-5).
            const tasks: Array<Promise<void>> = [];

            if (destination === "both" || destination === "twitch") {
                tasks.push(
                    this._sendToTwitch(result, trimmed, accountType, options.replyToMessageId ?? null)
                        .catch(() => {})
                );
            }

            if (destination === "both" || destination === "youtube") {
                const youtubeText = trimmed.replace(/^\/me\s+/i, "");
                tasks.push(
                    this._sendToYouTube(result, youtubeText, accountType)
                        .catch(() => {})
                );
            }

            await Promise.all(tasks);
        } catch (error) {
            logger.error("platform-dispatch: unexpected error while sending chat message:", error);
        }

        return result;
    }

    private async _sendToTwitch(
        result: ChatDispatchResult,
        message: string,
        accountType: string | null,
        replyToMessageId: string | null
    ): Promise<void> {
        const accounts = AccountAccess.getAccounts() ?? {} as { streamer?: { loggedIn?: boolean } };
        if (accounts.streamer?.loggedIn !== true) {
            logger.debug("platform-dispatch: Twitch is not connected; skipping the Twitch side of the send.");
            result.twitch = { attempted: false, success: false, skipped: "platform-not-connected" };
            return;
        }

        try {
            // Preserve the historical Twitch behavior: an explicit bot chatter
            // (the dashboard's "Bot" or an effect's saved "Bot") sends as the
            // Twitch bot when the bot account is logged in.
            const sendAsBot = (accountType ?? "").trim().toLowerCase() === "bot";

            const response: {
                success?: boolean;
                isSlashCommand?: boolean;
                messageId?: string;
                error?: string;
            } = await TwitchApi.chat.sendChatMessage(message, replyToMessageId, sendAsBot);

            result.twitch = {
                attempted: true,
                success: response?.success === true,
                isSlashCommand: response?.isSlashCommand === true,
                messageId: response?.messageId,
                error: response?.error
            };
        } catch (error) {
            const errorMessage = (error as Error)?.message ?? String(error);
            logger.error("platform-dispatch: Twitch chat send failed:", errorMessage);
            result.twitch = { attempted: true, success: false, error: errorMessage };
        }
    }

    private async _sendToYouTube(
        result: ChatDispatchResult,
        message: string,
        accountType: string | null
    ): Promise<void> {
        try {
            // The chat-sender owns live-chat-id tracking, chatter resolution,
            // truncation, serialization and the daily quota budget; it never
            // throws — skipped reasons come back in the result.
            const response = await youTubeChatSender.sendChatMessage(message, { accountType });

            result.youtube = {
                attempted: response.skipped == null,
                success: response.success === true,
                skipped: response.skipped,
                messageId: response.messageId,
                error: response.error
            };
        } catch (error) {
            const errorMessage = (error as Error)?.message ?? String(error);
            logger.error("platform-dispatch: YouTube chat send failed:", errorMessage);
            result.youtube = { attempted: true, success: false, error: errorMessage };
        }
    }
}

export const platformDispatch = new PlatformDispatcher();
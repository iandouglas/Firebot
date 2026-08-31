import { EventEmitter } from "events";

import type { AuthDetails } from "../../../../types";
import type ClientOAuth2 from "client-oauth2";

import authManager from "../../../auth/auth-manager";
import { LoggerCache } from "../../../logger-cache";

import type { YouTubeAccountContext, YouTubeAccountType, YouTubeChannelInfo } from "./contracts";
import { BOT_ACCOUNT_PROVIDER_ID, STREAMER_ACCOUNT_PROVIDER_ID } from "./youtube-auth";

const logger = LoggerCache.getLogger("YouTube");

/** Refresh when a token has less than five minutes of runway left. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

interface StoredAccount {
    providerId: string;
    auth: AuthDetails | null;
    channel: YouTubeChannelInfo | null;
}

export interface SetAuthOptions {
    /**
     * When false, no "account-updated" event fires (used when restoring
     * already-persisted state during init/connect so settings aren't rewritten).
     */
    emitUpdate?: boolean;
}

/**
 * In-memory store for the two linked YouTube accounts (streamer + bot).
 *
 * Tokens live here for the lifetime of the app; the streamer auth blob itself is
 * persisted by integration-manager (`/integrations/youtube/auth`) and the bot by
 * the integration via its `settings-update` persistence (see youtube.ts).
 *
 * Core invariant #5: the api-client resolves + refreshes tokens through this
 * store (`getFreshAccessToken`) before every call for BOTH accounts — the
 * framework auto-refresh only covers the primary auth blob.
 */
class YouTubeAccountStore extends EventEmitter {
    private readonly _accounts: Record<YouTubeAccountType, StoredAccount> = {
        streamer: {
            providerId: STREAMER_ACCOUNT_PROVIDER_ID,
            auth: null,
            channel: null
        },
        bot: {
            providerId: BOT_ACCOUNT_PROVIDER_ID,
            auth: null,
            channel: null
        }
    };

    /**
     * Token-expiry check that tolerates how AuthDetails round-trips through the
     * JSON db: `expires_at` may arrive as an ISO string instead of a Date.
     * Returns true when the token is unknown or within the expiry margin.
     */
    isTokenExpired(auth: AuthDetails | null | undefined): boolean {
        if (auth == null || !auth.access_token) {
            return true;
        }

        let expiresAtEPOCH = -1;
        const expiresAtDate = auth.expires_at as unknown;
        if (typeof expiresAtDate === "string") {
            const parsed = new Date(expiresAtDate).getTime();
            if (!Number.isNaN(parsed)) {
                expiresAtEPOCH = parsed;
            }
        } else if (expiresAtDate instanceof Date) {
            expiresAtEPOCH = expiresAtDate.getTime();
        }

        if (expiresAtEPOCH < 0 && typeof auth.obtainment_timestamp === "number" && typeof auth.expires_in === "number") {
            expiresAtEPOCH = auth.obtainment_timestamp + auth.expires_in * 1000;
        }

        if (expiresAtEPOCH < 0) {
            // No usable expiry info — let the API 401 drive the error path.
            return false;
        }

        return Date.now() >= expiresAtEPOCH - EXPIRY_MARGIN_MS;
    }

    setAuth(account: YouTubeAccountType, auth: AuthDetails | null, options: SetAuthOptions = {}): void {
        this._accounts[account].auth = auth;
        if (options.emitUpdate !== false) {
            this._emitUpdated(account);
        }
    }

    setChannel(account: YouTubeAccountType, channel: YouTubeChannelInfo | null, options: SetAuthOptions = {}): void {
        this._accounts[account].channel = channel;
        if (options.emitUpdate !== false) {
            this._emitUpdated(account);
        }
    }

    /** Full context; null until *both* an auth token and the channel are known. */
    getStreamerAccount(): YouTubeAccountContext | null {
        return this.getAccount("streamer");
    }

    getBotAccount(): YouTubeAccountContext | null {
        return this.getAccount("bot");
    }

    getAccount(account: YouTubeAccountType): YouTubeAccountContext | null {
        const stored = this._accounts[account];
        if (stored.auth == null || !stored.auth.access_token || stored.channel == null) {
            return null;
        }
        return {
            providerId: stored.providerId,
            channel: stored.channel,
            auth: stored.auth
        };
    }

    /** The raw stored auth blob (possibly without channel info known yet). */
    getRawAccount(account: YouTubeAccountType): { providerId: string; auth: AuthDetails; channel: YouTubeChannelInfo | null } | null {
        const stored = this._accounts[account];
        if (stored.auth == null || !stored.auth.access_token) {
            return null;
        }
        return { providerId: stored.providerId, auth: stored.auth, channel: stored.channel };
    }

    /**
     * Resolves the access token for an account, refreshing it first when the
     * stored token is expired. Returns null when there is no account or the
     * refresh fails (both surface as kind:"auth" errors from the api-client).
     */
    async getFreshAccessToken(account: YouTubeAccountType): Promise<string | null> {
        const stored = this._accounts[account];
        if (stored.auth == null || !stored.auth.access_token) {
            return null;
        }

        if (!this.isTokenExpired(stored.auth)) {
            return stored.auth.access_token;
        }

        const refreshed = await authManager.refreshTokenIfExpired(stored.providerId, stored.auth as unknown as ClientOAuth2.Data) as AuthDetails | null;
        if (refreshed == null || !refreshed.access_token) {
            logger.warn(`YouTube '${account}' account token refresh failed; token treated as unusable.`);
            return null;
        }

        this.setAuth(account, refreshed);
        return refreshed.access_token;
    }

    clear(account: YouTubeAccountType): void {
        this._accounts[account].auth = null;
        this._accounts[account].channel = null;
        this._emitUpdated(account);
    }

    clearAll(): void {
        this.clear("streamer");
        this.clear("bot");
    }

    private _emitUpdated(account: YouTubeAccountType): void {
        const stored = this._accounts[account];
        this.emit("account-updated", account, {
            providerId: stored.providerId,
            auth: stored.auth,
            channel: stored.channel
        } as Partial<YouTubeAccountContext>);
    }
}

export const youtubeAccountStore = new YouTubeAccountStore();
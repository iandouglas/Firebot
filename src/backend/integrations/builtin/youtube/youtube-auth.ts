import type { AuthProviderDefinition } from "../../../../types";

import { SecretsManager } from "../../../secrets-manager";

/**
 * Google OAuth providers for the YouTube integration (locked decision D2/D3).
 *
 * The streamer provider is exported as `definition.authProviderDetails`, so
 * integration-manager registers it and its generic `auth-success` handler links
 * the integration with the streamer token (matching ONLY that provider id).
 *
 * The bot provider must NOT be part of the definition — youtube.ts registers it
 * directly via `authManager.registerAuthProvider()` inside `init()` and listens
 * for its own `auth-success` events, so bot tokens never link the integration.
 */

export interface YouTubeAuthProviderDefinition extends AuthProviderDefinition {
    /** Read by integration-manager.connectIntegration for the primary (streamer) auth blob. */
    autoRefreshToken?: boolean;
}

export const STREAMER_ACCOUNT_PROVIDER_ID = "youtube:streamer-account";
export const BOT_ACCOUNT_PROVIDER_ID = "youtube:bot-account";

const GOOGLE_AUTHORIZE_HOST = "https://accounts.google.com";
// access_type=offline + prompt=consent => we always get a refresh token (D3)
const GOOGLE_AUTHORIZE_PATH = "/o/oauth2/v2/auth?access_type=offline&prompt=consent";
const GOOGLE_TOKEN_HOST = "https://oauth2.googleapis.com";
const GOOGLE_TOKEN_PATH = "/token";

const YOUTUBE_FORCE_SSL_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
const YOUTUBE_MEMBERSHIPS_SCOPE = "https://www.googleapis.com/auth/youtube.channel-memberships.creator";

const STREAMER_SCOPES = [YOUTUBE_FORCE_SSL_SCOPE, YOUTUBE_MEMBERSHIPS_SCOPE];
const BOT_SCOPES = [YOUTUBE_FORCE_SSL_SCOPE];

/** True when the user has installed their GCP OAuth client creds into secrets.json (WS-0). */
export function hasGoogleCredentials(): boolean {
    const secrets = getGoogleSecrets();
    return Boolean(secrets.clientId && secrets.clientSecret);
}

function getGoogleSecrets(): { clientId?: string; clientSecret?: string } {
    const secrets = SecretsManager.secrets ?? ({} as Partial<{ googleClientId: string; googleClientSecret: string }>);
    return {
        clientId: secrets.googleClientId,
        clientSecret: secrets.googleClientSecret
    };
}

function googleClient(): { id: string; secret?: string } {
    const { clientId, clientSecret } = getGoogleSecrets();
    return {
        id: clientId ?? "",
        secret: clientSecret ?? ""
    };
}

const codeAuth = () => ({
    type: "code" as const,
    authorizeHost: GOOGLE_AUTHORIZE_HOST,
    authorizePath: GOOGLE_AUTHORIZE_PATH,
    tokenHost: GOOGLE_TOKEN_HOST,
    tokenPath: GOOGLE_TOKEN_PATH
});

export const streamerAccountProvider: YouTubeAuthProviderDefinition = {
    id: STREAMER_ACCOUNT_PROVIDER_ID,
    name: "YouTube Channel Account",
    client: googleClient(),
    auth: codeAuth(),
    redirectUriHost: "localhost",
    scopes: STREAMER_SCOPES,
    autoRefreshToken: true
};

export const botAccountProvider: YouTubeAuthProviderDefinition = {
    id: BOT_ACCOUNT_PROVIDER_ID,
    name: "YouTube Bot Account",
    client: googleClient(),
    auth: codeAuth(),
    redirectUriHost: "localhost",
    scopes: BOT_SCOPES,
    autoRefreshToken: true
};
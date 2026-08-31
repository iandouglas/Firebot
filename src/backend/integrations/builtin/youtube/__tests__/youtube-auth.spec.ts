/**
 * Authorization-URI construction for both Google providers.
 *
 * Runs the REAL auth-manager + client-oauth2 code against the providers defined
 * in youtube-auth.ts, with auth-manager's heavy collaborators mocked and
 * SettingsManager pinned to the default WebServerPort (7472).
 */

import authManager from "../../../../auth/auth-manager";
import type { AuthProviderDefinition } from "../../../../../types";

import {
    BOT_ACCOUNT_PROVIDER_ID,
    STREAMER_ACCOUNT_PROVIDER_ID,
    botAccountProvider,
    hasGoogleCredentials,
    streamerAccountProvider
} from "../youtube-auth";

jest.mock("../../../../common/settings-manager", () => ({
    SettingsManager: {
        getSetting: jest.fn(() => 7472)
    }
}));

jest.mock("../../../../common/frontend-communicator", () => ({
    __esModule: true,
    default: {
        on: jest.fn(),
        onAsync: jest.fn(),
        send: jest.fn(),
        sendAsync: jest.fn()
    }
}));

jest.mock("../../../../logger-cache", () => ({
    LoggerCache: {
        getLogger: () => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        })
    }
}));

jest.mock("../../../../app-management/electron/window-management", () => ({
    __esModule: true,
    default: { mainWindow: null }
}));

jest.mock("../../../../secrets-manager", () => ({
    SecretsManager: {
        secrets: {
            googleClientId: "fake-google-client-id.apps.googleusercontent.com",
            googleClientSecret: "fake-google-client-secret"
        }
    }
}));

function expectSameShape(actual: AuthProviderDefinition | undefined, expected: AuthProviderDefinition): void {
    expect(actual).toBeDefined();
    expect(actual?.client).toEqual(expected.client);
    expect(actual?.scopes).toEqual(expected.scopes);
    expect(actual?.auth).toEqual(expected.auth);
}

describe("YouTube auth providers", () => {
    it("reports google credentials as available when both secrets exist", () => {
        expect(hasGoogleCredentials()).toBe(true);
    });
});

describe("authorization URI construction (registered with the real auth manager)", () => {
    beforeAll(() => {
        // Mirror production: integration-manager registers the streamer provider
        // straight off definition.authProviderDetails; youtube.ts registers the bot.
        authManager.registerAuthProvider(streamerAccountProvider);
        authManager.registerAuthProvider(botAccountProvider);
    });

    it("registers the streamer provider under its youtube:streamer-account id", () => {
        const provider = authManager.getAuthProvider(STREAMER_ACCOUNT_PROVIDER_ID);

        expect(provider).toBeDefined();
        expectSameShape(provider?.details, streamerAccountProvider);
    });

    it("builds the Google consent URI with access_type=offline + prompt=consent", () => {
        const provider = authManager.getAuthProvider(STREAMER_ACCOUNT_PROVIDER_ID);
        const uri = new URL(provider?.authorizationUri ?? "");

        expect(uri.origin).toBe("https://accounts.google.com");
        expect(uri.pathname).toBe("/o/oauth2/v2/auth");
        expect(uri.searchParams.get("access_type")).toBe("offline");
        expect(uri.searchParams.get("prompt")).toBe("consent");
        expect(uri.searchParams.get("response_type")).toBe("code");
    });

    it("requests both streamer scopes in the consent URI", () => {
        const provider = authManager.getAuthProvider(STREAMER_ACCOUNT_PROVIDER_ID);
        const uri = new URL(provider?.authorizationUri ?? "");

        const requestedScopes = uri.searchParams.get("scope")?.split(" ") ?? [];
        expect(requestedScopes).toEqual([
            "https://www.googleapis.com/auth/youtube.force-ssl",
            "https://www.googleapis.com/auth/youtube.channel-memberships.creator"
        ]);
    });

    it("redirects back to the Firebot web server callback on localhost:7472", () => {
        const provider = authManager.getAuthProvider(STREAMER_ACCOUNT_PROVIDER_ID);

        expect(provider?.redirectUri).toBe("http://localhost:7472/api/v1/auth/callback");
        const uri = new URL(provider?.authorizationUri ?? "");
        expect(uri.searchParams.get("redirect_uri")).toBe(provider?.redirectUri);
    });

    it("uses the fake Google client credentials and tags the state with the provider id", () => {
        const provider = authManager.getAuthProvider(STREAMER_ACCOUNT_PROVIDER_ID);
        const uri = new URL(provider?.authorizationUri ?? "");

        expect(uri.searchParams.get("client_id")).toBe("fake-google-client-id.apps.googleusercontent.com");
        expect(uri.searchParams.get("state")).toBe(STREAMER_ACCOUNT_PROVIDER_ID);
    });

    it("registers the bot provider with the force-ssl scope only", () => {
        const provider = authManager.getAuthProvider(BOT_ACCOUNT_PROVIDER_ID);

        expect(provider).toBeDefined();
        const scopes = provider?.details.scopes ?? [];
        expect(scopes).toEqual(["https://www.googleapis.com/auth/youtube.force-ssl"]);
        expect(provider?.details.auth.tokenHost).toBe("https://oauth2.googleapis.com");
    });

    it("does not allow the bot provider id to be confused with the streamer provider", () => {
        // integration-manager links integrations by matching
        // definition.authProviderDetails.id against auth-success providerId —
        // the streamer provider on the definition must be exactly that id.
        expect(streamerAccountProvider.id).toBe("youtube:streamer-account");
        expect(botAccountProvider.id).toBe("youtube:bot-account");
        expect(streamerAccountProvider.id).not.toBe(BOT_ACCOUNT_PROVIDER_ID);
    });

    it("exposes the token endpoint for refresh (client-oauth2 refresh path)", () => {
        const provider = authManager.getAuthProvider(STREAMER_ACCOUNT_PROVIDER_ID);

        expect(provider?.details.auth.tokenHost).toBe("https://oauth2.googleapis.com");
        expect(provider?.details.auth.tokenPath).toBe("/token");
    });
});
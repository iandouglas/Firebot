import * as path from "path";

/**
 * Tests the REAL overlay runtime source: `src/resources/overlay/js/platform-logo.js`.
 *
 * That script is loaded in the browser as a classic (non-module) script and exposes a
 * global (`window.FirebotPlatformLogo`) so the `firebot:chat` widget's serialized
 * eventHandler can call it. Under jest (node env) there's no `window`, so we shim one
 * onto `global`, `require` the script (which attaches the API to it), and read it back.
 * This keeps the test exercising the exact bytes that run in OBS rather than a TS copy.
 */
const scriptPath = path.resolve(__dirname, "../../../../../resources/overlay/js/platform-logo.js");

interface PlatformLogoApi {
    getPlatformLogoDataUri: (platform: "twitch" | "youtube" | undefined) => string | undefined;
    getPlatformLogoMarkup: (platform: "twitch" | "youtube" | undefined, className: string) => string;
}

function loadPlatformLogoScript(): PlatformLogoApi {
    const windowObj: { FirebotPlatformLogo?: PlatformLogoApi } = {};
    // The script closes over the free identifier `window`. Make it resolve to our shim.
    (global as unknown as { window: unknown }).window = windowObj;
    require(scriptPath);
    const api = windowObj.FirebotPlatformLogo;
    if (!api) {
        throw new Error("platform-logo.js did not expose window.FirebotPlatformLogo");
    }
    return api;
}

describe("platform-logo (overlay global script)", () => {
    let api: PlatformLogoApi;

    beforeAll(() => {
        api = loadPlatformLogoScript();
    });

    describe("getPlatformLogoDataUri", () => {
        it("returns a YouTube SVG data URI for the youtube platform", () => {
            const uri = api.getPlatformLogoDataUri("youtube");
            expect(uri).toBeDefined();
            expect(uri).toMatch(/^data:image\/svg\+xml,/);
            expect(uri).toContain("FF0000"); // YouTube brand red
        });

        it("returns a Twitch SVG data URI for the twitch platform", () => {
            const uri = api.getPlatformLogoDataUri("twitch");
            expect(uri).toBeDefined();
            expect(uri).toMatch(/^data:image\/svg\+xml,/);
            expect(uri).toContain("9146FF"); // Twitch brand purple
        });

        it("treats an undefined platform as Twitch (legacy messages carry no platform)", () => {
            expect(api.getPlatformLogoDataUri(undefined)).toBe(api.getPlatformLogoDataUri("twitch"));
        });
    });

    describe("getPlatformLogoMarkup", () => {
        it("returns an <img> tag with the given class for youtube", () => {
            const markup = api.getPlatformLogoMarkup("youtube", "chat-platform-logo-abc");
            expect(markup).toContain("<img");
            expect(markup).toContain('class="chat-platform-logo-abc"');
            expect(markup).toContain('alt="YouTube logo"');
            expect(markup).toContain("data:image/svg+xml,");
        });

        it("returns an <img> tag with the given class for twitch", () => {
            const markup = api.getPlatformLogoMarkup("twitch", "chat-platform-logo-abc");
            expect(markup).toContain("<img");
            expect(markup).toContain('class="chat-platform-logo-abc"');
            expect(markup).toContain('alt="Twitch logo"');
        });

        it("treats an undefined platform as Twitch", () => {
            expect(api.getPlatformLogoMarkup(undefined, "chat-platform-logo-abc")).toContain('alt="Twitch logo"');
        });
    });
});

import {
    getPlatformLogoDataUri,
    getPlatformLogoMarkup
} from "../platform-logo";

describe("platform-logo", () => {
    describe("getPlatformLogoDataUri", () => {
        it("returns a YouTube SVG data URI for the youtube platform", () => {
            const uri = getPlatformLogoDataUri("youtube");
            expect(uri).toBeDefined();
            expect(uri).toMatch(/^data:image\/svg\+xml,/);
            expect(uri).toContain("FF0000"); // YouTube brand red
        });

        it("returns a Twitch SVG data URI for the twitch platform", () => {
            const uri = getPlatformLogoDataUri("twitch");
            expect(uri).toBeDefined();
            expect(uri).toMatch(/^data:image\/svg\+xml,/);
            expect(uri).toContain("9146FF"); // Twitch brand purple
        });

        it("treats an undefined platform as Twitch (legacy messages carry no platform)", () => {
            const uri = getPlatformLogoDataUri(undefined);
            expect(uri).toBe(getPlatformLogoDataUri("twitch"));
        });

        it("returns undefined for an unknown platform", () => {
            // @ts-expect-error - intentionally passing an invalid platform
            expect(getPlatformLogoDataUri("unknown")).toBeUndefined();
        });
    });

    describe("getPlatformLogoMarkup", () => {
        it("returns an <img> tag with the given class for youtube", () => {
            const markup = getPlatformLogoMarkup("youtube", "chat-platform-logo-abc");
            expect(markup).toContain("<img");
            expect(markup).toContain('class="chat-platform-logo-abc"');
            expect(markup).toContain('alt="YouTube logo"');
            expect(markup).toContain("data:image/svg+xml,");
        });

        it("returns an <img> tag with the given class for twitch", () => {
            const markup = getPlatformLogoMarkup("twitch", "chat-platform-logo-abc");
            expect(markup).toContain("<img");
            expect(markup).toContain('class="chat-platform-logo-abc"');
            expect(markup).toContain('alt="Twitch logo"');
        });

        it("treats an undefined platform as Twitch", () => {
            const markup = getPlatformLogoMarkup(undefined, "chat-platform-logo-abc");
            expect(markup).toContain('alt="Twitch logo"');
        });

        it("returns an empty string for an unknown platform", () => {
            // @ts-expect-error - intentionally passing an invalid platform
            expect(getPlatformLogoMarkup("unknown", "chat-platform-logo-abc")).toBe("");
        });
    });
});

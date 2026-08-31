import {
    VIEWER_PLATFORMS,
    inferViewerPlatformFromId,
    isViewerPlatform,
    parseViewerId,
    rawIdFromPlatform,
    safeParseViewerId,
    scopeViewerId,
    unscopeViewerId
} from "../src/backend/viewers/viewer-identity";

describe("viewer-identity", () => {
    describe("VIEWER_PLATFORMS", () => {
        it("declares the two supported platforms", () => {
            expect(VIEWER_PLATFORMS).toEqual(["twitch", "youtube"]);
        });
    });

    describe("isViewerPlatform", () => {
        it.each(["twitch", "youtube"])("accepts known platform %s", (platform) => {
            expect(isViewerPlatform(platform)).toBe(true);
            expect(isViewerPlatform(`${platform}:123`)).toBe(false);
        });

        it.each(["discord", "twitchy", "Twitch", "", null, undefined, 123])("rejects unknown platform %p", (value) => {
            expect(isViewerPlatform(value)).toBe(false);
        });
    });

    describe("scopeViewerId", () => {
        it("scopes a raw Twitch id", () => {
            expect(scopeViewerId("twitch", "12345678")).toBe("twitch:12345678");
        });

        it("scopes a raw YouTube channel id", () => {
            expect(scopeViewerId("youtube", "UCX6OQ3DkcsbYNE6H8uQQuVA")).toBe("youtube:UCX6OQ3DkcsbYNE6H8uQQuVA");
        });

        it("round-trips through parseViewerId for both platforms", () => {
            for (const platform of VIEWER_PLATFORMS) {
                const rawId = platform === "twitch" ? "999888777" : "UCX6OQ3DkcsbYNE6H8uQQuVA";
                const scopedId = scopeViewerId(platform, rawId);
                expect(parseViewerId(scopedId)).toEqual({ platform, rawId });
            }
        });

        it.each([
            [undefined, "123"],
            ["discord", "123"],
            ["twitch", ""],
            ["twitch", "   "],
            [undefined, ""],
            ["youtube", null]
        ])("throws for platform %p and raw id %p", (platform, rawId) => {
            expect(() => scopeViewerId(platform as never, rawId as string)).toThrow();
        });

        it("refuses to double-scope an already scoped id", () => {
            expect(() => scopeViewerId("twitch", "twitch:123")).toThrow(/already scoped/);
            expect(() => scopeViewerId("youtube", "twitch:123")).toThrow(/already scoped/);
        });
    });

    describe("parseViewerId", () => {
        it("parses both platform scopes", () => {
            expect(parseViewerId("twitch:123")).toEqual({ platform: "twitch", rawId: "123" });
            expect(parseViewerId("youtube:UCX6OQ3DkcsbYNE6H8uQQuVA")).toEqual({
                platform: "youtube",
                rawId: "UCX6OQ3DkcsbYNE6H8uQQuVA"
            });
        });

        it.each([
            [""],
            ["   "],
            ["12345678"],
            ["UCX6OQ3DkcsbYNE6H8uQQuVA"],
            [":123"],
            ["twitch:"],
            ["youtube: "],
            ["discord:123"],
            ["twitchy:123"],
            [null as unknown as string]
        ])("throws for malformed id %p", (id) => {
            expect(() => parseViewerId(id)).toThrow();
        });

        it("throws for non-string input", () => {
            expect(() => parseViewerId(undefined as unknown as string)).toThrow();
            expect(() => parseViewerId(123 as unknown as string)).toThrow();
        });
    });

    describe("safeParseViewerId", () => {
        it("returns the same shape as parseViewerId for valid ids", () => {
            expect(safeParseViewerId("twitch:123")).toEqual({ platform: "twitch", rawId: "123" });
        });

        it("returns null for malformed ids instead of throwing", () => {
            expect(safeParseViewerId("")).toBeNull();
            expect(safeParseViewerId("12345678")).toBeNull();
            expect(safeParseViewerId("discord:123")).toBeNull();
            expect(safeParseViewerId("twitch:")).toBeNull();
            expect(safeParseViewerId(undefined as unknown as string)).toBeNull();
        });
    });

    describe("rawIdFromPlatform", () => {
        it("returns the raw id when the platform matches", () => {
            expect(rawIdFromPlatform("twitch", "twitch:123")).toBe("123");
            expect(rawIdFromPlatform("youtube", "youtube:UCX6OQ3DkcsbYNE6H8uQQuVA")).toBe("UCX6OQ3DkcsbYNE6H8uQQuVA");
        });

        it("returns null when the platform does not match or the id is not scoped", () => {
            expect(rawIdFromPlatform("twitch", "youtube:UCX6OQ3DkcsbYNE6H8uQQuVA")).toBeNull();
            expect(rawIdFromPlatform("youtube", "twitch:123")).toBeNull();
            expect(rawIdFromPlatform("twitch", "123")).toBeNull();
            expect(rawIdFromPlatform("twitch", undefined as unknown as string)).toBeNull();
        });
    });

    describe("unscopeViewerId", () => {
        it("strips the platform prefix from scoped ids", () => {
            expect(unscopeViewerId("twitch:123")).toBe("123");
            expect(unscopeViewerId("youtube:UCX6OQ3DkcsbYNE6H8uQQuVA")).toBe("UCX6OQ3DkcsbYNE6H8uQQuVA");
        });

        it("passes raw ids and garbage through untouched", () => {
            expect(unscopeViewerId("123")).toBe("123");
            expect(unscopeViewerId("UCX6OQ3DkcsbYNE6H8uQQuVA")).toBe("UCX6OQ3DkcsbYNE6H8uQQuVA");
            expect(unscopeViewerId("")).toBe("");
        });
    });

    describe("inferViewerPlatformFromId", () => {
        it("infers youtube for YouTube channel-shaped ids", () => {
            expect(inferViewerPlatformFromId("UCX6OQ3DkcsbYNE6H8uQQuVA")).toBe("youtube");
            expect(inferViewerPlatformFromId("UCabcdefghijklmnopqrst")).toBe("youtube");
            expect(inferViewerPlatformFromId("UCabc-abc_abc-abc-abcdef")).toBe("youtube");
        });

        it("infers twitch for everything else", () => {
            expect(inferViewerPlatformFromId("12345678")).toBe("twitch");
            expect(inferViewerPlatformFromId("UC12345678")).toBe("twitch"); // too short
            expect(inferViewerPlatformFromId("UCabcdefghijklmnopqrstuvwx!")).toBe("twitch"); // invalid char + no dash
            expect(inferViewerPlatformFromId("twitch:123")).toBe("twitch"); // colon not in UC pattern
            expect(inferViewerPlatformFromId("")).toBe("twitch");
            expect(inferViewerPlatformFromId(null as unknown as string)).toBe("twitch");
        });

        it("matches the documented ^UC[\\w-]{20,}$ rule", () => {
            // 20 chars after UC is the boundary
            expect(inferViewerPlatformFromId("UCabcdefghijklmnopqrst")).toBe("youtube");
            expect(inferViewerPlatformFromId("UCabcdefghijklmnopqrs")).toBe("twitch");
        });
    });

    describe("scope/parse round-trip", () => {
        it("is stable for arbitrary raw ids", () => {
            const rawIds = ["1", "0", "999999999999999999", "UC-X_abc123-X_abc123-X_abc", "UC" + "y".repeat(30)];
            for (const rawId of rawIds) {
                const platform = inferViewerPlatformFromId(rawId);
                const scopedId = scopeViewerId(platform, rawId);
                expect(parseViewerId(scopedId)).toEqual({ platform, rawId });
                expect(unscopeViewerId(scopedId)).toBe(rawId);
            }
        });
    });
});
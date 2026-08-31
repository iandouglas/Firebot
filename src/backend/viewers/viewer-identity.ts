/**
 * Central viewer identity helpers (WS-3 / decision D9).
 *
 * Every viewer record in the viewer database is keyed `_id = "<platform>:<user_id>"`
 * (e.g. `twitch:12345`, `youtube:UCabc...`). Scoping/unscoping must ALWAYS go
 * through these helpers — never build a scoped `_id` by hand.
 *
 * Platform-scoped ids belong to the DB boundary only: `FirebotChatMessage.userId`,
 * event metadata, and all Twitch/YouTube API calls carry RAW platform ids.
 */

/**
 * A YouTube channel id looks like `UC` followed by at least 20 word characters
 * or dashes (e.g. `UCX6OQ3DkcsbYNE6H8uQQuVA`).
 */
const YOUTUBE_CHANNEL_ID_PATTERN = /^UC[\w-]{20,}$/;

/**
 * All platforms the viewer database keys records by. Order matters: it is the
 * canonical declaration order for `ViewerPlatform`.
 */
export const VIEWER_PLATFORMS = ["twitch", "youtube"] as const;

export type ViewerPlatform = (typeof VIEWER_PLATFORMS)[number];

/**
 * Type guard for a platform string coming from data (DB records, API payloads).
 */
export function isViewerPlatform(value: unknown): value is ViewerPlatform {
    return typeof value === "string" && (VIEWER_PLATFORMS as readonly string[]).includes(value);
}

function assertPlatform(platform: unknown): void {
    if (!isViewerPlatform(platform)) {
        throw new Error(`Unknown viewer platform: ${String(platform)}. Expected one of: ${VIEWER_PLATFORMS.join(", ")}`);
    }
}

/**
 * Combines a platform and a raw platform user id into a scoped viewer id
 * (e.g. `scopeViewerId("twitch", "12345")` => `"twitch:12345"`).
 *
 * @throws if the platform is unknown, the raw id is empty, or the raw id is
 * already a scoped viewer id (guards against double-scoping).
 */
export function scopeViewerId(platform: ViewerPlatform, rawId: string): string {
    assertPlatform(platform);
    if (typeof rawId !== "string" || rawId.trim() === "") {
        throw new Error(`Invalid raw viewer id for platform "${platform}": ${String(rawId)}`);
    }
    if (safeParseViewerId(rawId) != null) {
        throw new Error(`Raw viewer id "${rawId}" is already scoped for platform "${platform}"`);
    }
    return `${platform}:${rawId}`;
}

function assertScopedId(scopedId: string): { platform: ViewerPlatform; rawId: string } {
    if (typeof scopedId !== "string" || scopedId.trim() === "") {
        throw new Error(`Invalid scoped viewer id: ${String(scopedId)}`);
    }
    const separatorIndex = scopedId.indexOf(":");
    if (separatorIndex < 1) {
        throw new Error(`Scoped viewer id "${scopedId}" is missing a platform prefix`);
    }

    const platform = scopedId.slice(0, separatorIndex);
    const rawId = scopedId.slice(separatorIndex + 1);

    if (!isViewerPlatform(platform)) {
        throw new Error(`Unknown viewer platform "${platform}" in scoped id "${scopedId}"`);
    }
    if (rawId.trim() === "") {
        throw new Error(`Scoped viewer id "${scopedId}" is missing its raw user id`);
    }

    return { platform, rawId };
}

/**
 * Splits a scoped viewer id (e.g. `"youtube:UCabc..."`) into its platform and
 * raw user id. Inverse of `scopeViewerId`.
 *
 * @throws if the id is not a valid scoped viewer id.
 */
export function parseViewerId(scopedId: string): { platform: ViewerPlatform; rawId: string } {
    return assertScopedId(scopedId);
}

/**
 * Non-throwing `parseViewerId`: returns `null` instead of throwing when the id
 * is not a valid scoped viewer id.
 */
export function safeParseViewerId(scopedId: string): { platform: ViewerPlatform; rawId: string } | null {
    try {
        return assertScopedId(scopedId);
    } catch {
        return null;
    }
}

/**
 * Extracts the raw user id from a scoped viewer id, but only when it is scoped
 * to the given platform. Returns `null` otherwise.
 */
export function rawIdFromPlatform(platform: ViewerPlatform, scopedId: string): string | null {
    const parsed = safeParseViewerId(scopedId);
    return parsed?.platform === platform ? parsed.rawId : null;
}

/**
 * Best-effort inverse of `scopeViewerId`: returns the raw user id part of a
 * scoped viewer id, or the input unchanged when it isn't scoped. Useful for
 * stripping scoping off ids destined for APIs or event metadata.
 */
export function unscopeViewerId(scopedId: string): string {
    return safeParseViewerId(scopedId)?.rawId ?? scopedId;
}

/**
 * Infers the viewer platform for a record id that predates the platform re-key:
 * YouTube channel ids (`^UC[\w-]{20,}$`) are "youtube", everything else is
 * treated as a legacy Twitch id.
 */
export function inferViewerPlatformFromId(id: string): ViewerPlatform {
    if (typeof id !== "string") {
        return "twitch";
    }
    return YOUTUBE_CHANNEL_ID_PATTERN.test(id) ? "youtube" : "twitch";
}
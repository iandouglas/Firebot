/**
 * Platform logo helpers for the chat overlay widget.
 *
 * Renders a small inline-SVG brand logo (Twitch or YouTube) next to a chat
 * message so a blended feed can show which platform a message came from.
 *
 * The logos are self-contained SVG data URIs so the overlay works fully
 * offline (no external image requests). `platform` is `"youtube"` for YouTube
 * messages and `undefined` for Twitch (legacy behavior — see the
 * `FirebotChatMessage.platform` type), so `undefined` is treated as Twitch.
 */

const TWITCH_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#9146FF"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/></svg>`;

const YOUTUBE_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#FF0000"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`;

function svgToDataUri(svg: string): string {
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const TWITCH_LOGO_DATA_URI = svgToDataUri(TWITCH_LOGO_SVG);
const YOUTUBE_LOGO_DATA_URI = svgToDataUri(YOUTUBE_LOGO_SVG);

/**
 * Returns the SVG data URI for a platform's brand logo, or `undefined` for an
 * unknown platform. `undefined`/`"twitch"` both resolve to the Twitch logo
 * (legacy messages carry no platform).
 */
export function getPlatformLogoDataUri(platform: "twitch" | "youtube" | undefined): string | undefined {
    switch (platform) {
        case "youtube":
            return YOUTUBE_LOGO_DATA_URI;
        case "twitch":
        case undefined:
            return TWITCH_LOGO_DATA_URI;
        default:
            return undefined;
    }
}

/**
 * Returns an `<img>` element string for the platform logo, or an empty string
 * when the platform is unknown. `className` is applied so the widget can size
 * the logo via its own CSS.
 */
export function getPlatformLogoMarkup(platform: "twitch" | "youtube" | undefined, className: string): string {
    const dataUri = getPlatformLogoDataUri(platform);
    if (!dataUri) {
        return "";
    }
    const alt = platform === "youtube" ? "YouTube" : "Twitch";
    return `<img class="${className}" src="${dataUri}" alt="${alt} logo" />`;
}

/*
    PLATFORM LOGO HELPERS FOR FIREBOT'S OVERLAY WIDGETS.

    Loaded as a classic (non-module) script and exposes a global so that overlay
    widget extension eventHandlers — which are serialized to a function string and
    re-evaluated in the browser, so they can only reference browser globals — can
    render a Twitch/YouTube brand logo next to a chat message.

    The logos are self-contained inline SVG data URIs so the overlay works fully
    offline. `platform` is "youtube" for YouTube messages and undefined for Twitch
    (legacy), so undefined is treated as Twitch.

    Mirrored by the jest test `__tests__/platform-logo.spec.ts`.
*/
(function (global) {
    const TWITCH_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#9146FF"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/></svg>`;
    const YOUTUBE_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#FF0000"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`;

    function svgToDataUri(svg) {
        return `data:image/svg+xml,${encodeURIComponent(svg)}`;
    }

    const TWITCH_LOGO_DATA_URI = svgToDataUri(TWITCH_LOGO_SVG);
    const YOUTUBE_LOGO_DATA_URI = svgToDataUri(YOUTUBE_LOGO_SVG);

    /** Returns the SVG data URI for a platform's brand logo (twitch is the fallback). */
    function getPlatformLogoDataUri(platform) {
        if (platform === "youtube") {
            return YOUTUBE_LOGO_DATA_URI;
        }
        // "twitch" and undefined (legacy) both resolve to the Twitch logo.
        return TWITCH_LOGO_DATA_URI;
    }

    /** Returns an <img> element string for the platform logo, or "" for unknown platforms. */
    function getPlatformLogoMarkup(platform, className) {
        const dataUri = getPlatformLogoDataUri(platform);
        if (!dataUri) {
            return "";
        }
        const alt = platform === "youtube" ? "YouTube" : "Twitch";
        return `<img class="${className}" src="${dataUri}" alt="${alt} logo" />`;
    }

    global.FirebotPlatformLogo = {
        getPlatformLogoDataUri: getPlatformLogoDataUri,
        getPlatformLogoMarkup: getPlatformLogoMarkup
    };
})(window);

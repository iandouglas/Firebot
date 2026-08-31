"use strict";

(function() {
    angular
        .module('firebotApp')
        .factory('youtubeErrorsService', function(backendCommunicator, ngToast) {
            const service = {};

            // WS-10 error surfacing: quota/rate-limit errors from the YouTube
            // module should surface as a toast (not silently). The backend
            // currently escalates the daily send-cap via the generic
            // frontendCommunicator "error" event (chat-sender.ts), so we detect
            // YouTube quota/rate-limit messages there. A dedicated "youtube:error"
            // event is also handled for future backend wiring (see WS-10 notes).
            const YOUTUBE_ERROR_PATTERN = /youtube/i;

            const showYouTubeErrorToast = (message) => {
                if (typeof message !== "string" || message.length === 0) {
                    return;
                }
                ngToast.create({
                    className: "danger",
                    content: `<div class="rich-toast">
                        <div class="rich-toast-header">YouTube</div>
                        <div class="rich-toast-body">
                            <div class="modal-icon"><i class="fad fa-exclamation-circle" aria-hidden="true"></i></div>
                            <div class="rich-toast-body-content">${message}</div>
                        </div>
                    </div>`,
                    dismissOnTimeout: false,
                    dismissOnClick: false,
                    dismissButton: true
                });
            };

            // Dedicated YouTube error event (future backend wiring). Payload is a
            // string message or { message }.
            backendCommunicator.on("youtube:error", (payload) => {
                const message = typeof payload === "string" ? payload : payload?.message;
                showYouTubeErrorToast(message);
            });

            // The backend currently escalates the YouTube daily send-cap via the
            // generic "error" event. Detect YouTube quota/rate-limit messages so
            // they surface as a toast in addition to the standard error modal.
            backendCommunicator.on("error", (errorMessage) => {
                if (typeof errorMessage !== "string") {
                    return;
                }
                if (YOUTUBE_ERROR_PATTERN.test(errorMessage)
                    && /quota|rate|limit|capped/i.test(errorMessage)) {
                    showYouTubeErrorToast(errorMessage);
                }
            });

            return service;
        });
}());

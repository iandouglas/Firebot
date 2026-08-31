"use strict";

(function() {
    angular
        .module('firebotApp')
        .factory('youtubeMembersService', function(backendCommunicator) {
            const service = {};

            // Whether the YouTube members API is usable (false pre-enrollment /
            // on 403/quota/auth). Drives whether the "Members" category renders.
            service.available = false;

            // Cached roster: [{ channelId, displayName, levelName }].
            service.members = [];

            // channelId -> true, for O(1) membership lookups against chat users.
            service.memberIds = {};

            backendCommunicator.on("youtube:members-updated", (payload) => {
                if (payload == null) {
                    return;
                }
                service.available = payload.available === true;
                service.members = Array.isArray(payload.members) ? payload.members : [];
                service.memberIds = {};
                service.members.forEach((member) => {
                    if (member != null && member.channelId != null) {
                        service.memberIds[member.channelId] = true;
                    }
                });
            });

            /**
             * Roster members who are currently present in the given chat users
             * list (the CHAT USERS panel shows members present in chat). Returns
             * an empty list when the roster is unavailable or empty, so the
             * "Members" category hides itself.
             */
            service.getMembersInChat = function(chatUsers) {
                if (!service.available || service.members.length === 0) {
                    return [];
                }
                return chatUsers.filter(user => service.memberIds[user.id] === true);
            };

            return service;
        });
}());

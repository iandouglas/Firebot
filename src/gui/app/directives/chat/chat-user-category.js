"use strict";
(function() {
    angular
        .module('firebotApp')
        .component("chatUserCategory", {
            bindings: {
                category: "@",
                roleKey: "@"
            },
            template: `
            <div
                ng-show="filtered != null && filtered.length > 0"
                style="margin-bottom:15px;"
            >
                <div style="font-size: 12px; opacity: 0.6;">{{$ctrl.category}}</div>
                <div
                    class="chat-user-wrapper"
                    ng-repeat="user in $ctrl.getUsers() | chatUserRole:$ctrl.roleKey | orderBy:'username':true | orderBy:'active':true as filtered track by user.id"
                >
                    <div class="chat-user-img-wrapper">
                        <img ng-src="{{user.profilePicUrl}}" />
                        <span
                            class="chat-user-status"
                            ng-class="{ active: user.active }"
                            uib-tooltip="{{user.active ? 'Active chat user' : 'Inactive chat user (Lurking)'}}"
                            tooltip-append-to-body="true"
                        ></span>
                        </div>
                    <div
                        class="chat-user-name clickable"
                        ng-click="showUserDetailsModal(user.id)"
                        >
                        {{user.displayName}}<span ng-if="user.username && user.username.toLowerCase() !== user.displayName.toLowerCase()">&nbsp;({{user.username}})</span>
                    </div>
                </div>
            </div>
            `,
            controller: function($scope, chatMessagesService, utilityService, youtubeMembersService) {

                const $ctrl = this;

                $scope.cms = chatMessagesService;

                // The "Members" category (role-key "member") is fed by the YouTube
                // members roster: it renders roster members who are currently
                // present in chat. The chatUserRole filter passes unknown role
                // keys through, so the pre-filtered member list is shown as-is.
                // Every other category keeps the full chat user list.
                $ctrl.getUsers = function() {
                    if (this.roleKey === "member") {
                        return youtubeMembersService.getMembersInChat($scope.cms.getFilteredChatUserList());
                    }
                    return $scope.cms.getFilteredChatUserList();
                };

                $scope.showUserDetailsModal = (userId) => {
                    if (userId == null) {
                        return;
                    }

                    const closeFunc = () => {};
                    utilityService.showModal({
                        component: "viewerDetailsModal",
                        backdrop: true,
                        resolveObj: {
                            userId: () => userId
                        },
                        closeCallback: closeFunc,
                        dismissCallback: closeFunc
                    });
                };
            }
        });
}());

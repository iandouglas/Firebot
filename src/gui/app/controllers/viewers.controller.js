"use strict";

(function() {

    angular
        .module("firebotApp")
        .controller("viewersController", function(
            $route,
            $scope,
            viewersService,
            currencyService,
            utilityService,
            settingsService,
            ngToast
        ) {
            $scope.isViewerDBOn = settingsService.getSetting("ViewerDB");
            $scope.viewerTablePageSize = settingsService.getSetting("ViewerListPageSize");

            $scope.turnOnDatabase = () => {
                settingsService.saveSetting("ViewerDB", true);
                $scope.isViewerDBOn = true;
            };

            $scope.showUserDetailsModal = (userId) => {
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

            $scope.showImportViewersModal = () => {
                utilityService.showModal({
                    component: "importViewersModal",
                    closeCallback: () => {
                        $route.reload();
                    }
                });
            };

            $scope.showExportViewersModal = () => {
                utilityService.showModal({
                    component: "exportViewersModal",
                    closeCallback: (response) => {
                        if (response.success) {
                            ngToast.create({
                                className: 'success',
                                content: 'Viewers exported!'
                            });
                        } else {
                            ngToast.create({
                                className: 'danger',
                                content: 'Failed to export viewers'
                            });
                        }

                        $route.reload();
                    }
                });
            };

            $scope.showPurgeViewersModal = () => {
                utilityService.showModal({
                    component: "purgeViewersModal",
                    size: 'sm',
                    backdrop: false,
                    keyboard: true
                });
            };

            $scope.viewerRowClicked = (data) => {
                $scope.showUserDetailsModal(data._id);
            };

            $scope.showViewerSearchModal = () => {
                utilityService.openViewerSearchModal(
                    {
                        label: "Viewer Search",
                        saveText: "Select"
                    },
                    (user) => {
                        $scope.showUserDetailsModal(user.id);
                    });
            };

            $scope.vs = viewersService;

            // WS-10: platform filter for the Viewers page. Applied client-side to
            // the fetched page (backend page handler is out of WS-10 scope).
            $scope.platformFilter = viewersService.platformFilter;
            $scope.platformFilterOptions = [
                { value: null, label: "All Platforms" },
                { value: "twitch", label: "Twitch" },
                { value: "youtube", label: "YouTube" }
            ];
            $scope.platformFilterLabel = "All Platforms";
            $scope.setPlatformFilter = (value) => {
                viewersService.platformFilter = value;
                $scope.platformFilter = value;
                const match = $scope.platformFilterOptions.find(o => o.value === value);
                $scope.platformFilterLabel = match ? match.label : "All Platforms";
                viewersService.refreshViewers();
            };


            $scope.viewerSearch = "";

            $scope.headers = [
                {
                    headerStyles: {
                        'width': '50px'
                    },
                    sortable: false,
                    cellTemplate: `<img ng-src="{{data.twitch ? data.profilePicUrl : '../images/placeholders/default-profile-pic.png'}}"  style="width: 25px;height: 25px;border-radius: 25px;"/>`,
                    cellController: () => {}
                },
                {
                    name: "PLATFORM",
                    icon: "fa-globe",
                    dataField: "platform",
                    headerStyles: {
                        'min-width': '90px'
                    },
                    sortable: true,
                    cellTemplate: `<span ng-if="data.platform === 'youtube'" class="platform-badge" uib-tooltip="YouTube" tooltip-append-to-body="true"><i class="fab fa-youtube" style="color:#ff0000;"></i></span><span ng-if="data.platform !== 'youtube'" class="platform-badge" uib-tooltip="Twitch" tooltip-append-to-body="true"><i class="fab fa-twitch" style="color:#9146ff;"></i></span>`,
                    cellController: () => {}
                },
                {
                    name: "USERNAME",
                    icon: "fa-user",
                    dataField: "username",
                    headerStyles: {
                        'min-width': '125px'
                    },
                    sortable: true,
                    cellTemplate: `{{data.displayName || data.username}}<span ng-if="data.displayName && data.username.toLowerCase() !== data.displayName.toLowerCase()" class="muted"> ({{data.username}})</span>`,
                    cellController: () => {}
                },
                {
                    name: "JOIN DATE",
                    icon: "fa-sign-in",
                    dataField: "joinDate",
                    sortable: true,
                    cellTemplate: `{{data.joinDate | prettyDate}}`,
                    cellController: () => {}
                },
                {
                    name: "LAST SEEN",
                    icon: "fa-eye",
                    dataField: "lastSeen",
                    sortable: true,
                    cellTemplate: `{{data.lastSeen | prettyDate}}`,
                    cellController: () => {}
                },
                {
                    name: "VIEW TIME (hours)",
                    icon: "fa-tv",
                    dataField: "minutesInChannel",
                    sortable: true,
                    cellTemplate: `{{getViewTimeDisplay(data.minutesInChannel)}}`,
                    cellController: ($scope) => {
                        $scope.getViewTimeDisplay = (minutesInChannel) => {
                            return minutesInChannel < 60 ? 'Less than an hour' : Math.round(minutesInChannel / 60);
                        };
                    }
                },
                {
                    name: "CHAT MESSAGES",
                    icon: "fa-comments",
                    dataField: "chatMessages",
                    sortable: true,
                    cellTemplate: `{{data.chatMessages}}`,
                    cellController: () => {}
                }
            ];

            $scope.currencies = currencyService.getCurrencies();

            for (const currency of $scope.currencies) {
                $scope.headers.push({
                    name: currency.name.toUpperCase(),
                    icon: "fa-money-bill",
                    dataField: `currency.${currency.id}`,
                    sortable: true,
                    cellTemplate: `{{data.currency['${currency.id}']}}`,
                    cellController: () => {}
                });
            }

            $scope.headers.push({
                headerStyles: {
                    'width': '15px'
                },
                cellStyles: {
                    'width': '15px'
                },
                sortable: false,
                cellTemplate: `<i class="fal fa-chevron-right"></i>`,
                cellController: () => {}
            });
        });
}());

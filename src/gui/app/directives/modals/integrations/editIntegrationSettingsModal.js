"use strict";

(function() {
    angular.module("firebotApp").component("editIntegrationUserSettingsModal", {
        template: `
            <div class="modal-header">
                <button type="button" class="close" aria-label="Close" ng-click="$ctrl.dismiss()"><span aria-hidden="true">&times;</span></button>
                <h4 class="modal-title">
                    <div style="font-size: 22px;">Configure Integration:</div>
                    <div style="font-weight:bold;font-size: 24px;">{{$ctrl.integration.name}}</div>
                </h4>
            </div>
            <div class="modal-body">

                <setting-container ng-if="$ctrl.integration.settingCategories != null" ng-repeat="categoryMeta in $ctrl.settingCategoriesArray | orderBy:'sortRank'"  header="{{categoryMeta.title}}" description="{{categoryMeta.description}}" pad-top="$index > 0 ? true : false" collapsed="false">
                    <div ng-repeat="setting in categoryMeta.settingsArray | orderBy:'sortRank'">
                        <dynamic-parameter
                            ng-if="setting.type !== 'youtube-bot-auth'"
                            name="{{setting.settingName}}"
                            schema="setting"
                            ng-model="$ctrl.integration.settingCategories[categoryMeta.categoryName].settings[setting.settingName].value"
                        ></dynamic-parameter>
                        <youtube-bot-auth-setting
                            ng-if="setting.type === 'youtube-bot-auth'"
                            schema="setting"
                            bot-channel="$ctrl.integration.settings.botChannel"
                        ></youtube-bot-auth-setting>
                    </div>
                </setting-container>

            </div>
            <div class="modal-footer sticky-footer edit-integration-footer" style="margin-top:15px">
                <!--<button ng-show="$ctrl.integration != null" type="button" class="btn btn-danger pull-left" ng-click="$ctrl.resetToDefaults()">Reset to default</button>-->
                <button type="button" class="btn btn-link" ng-click="$ctrl.dismiss()">Cancel</button>
                <button ng-show="$ctrl.integration != null" type="button" class="btn btn-primary" ng-click="$ctrl.save()">Save</button>
            </div>
            <scroll-sentinel element-class="edit-integration-footer"></scroll-sentinel>
            `,
        bindings: {
            resolve: "<",
            close: "&",
            dismiss: "&"
        },
        controller: function(ngToast, utilityService) {
            const $ctrl = this;

            $ctrl.integration = null;

            $ctrl.settingCategoriesArray = [];

            $ctrl.$onInit = function() {
                if ($ctrl.resolve.integration) {
                    $ctrl.integration = JSON.parse(JSON.stringify($ctrl.resolve.integration));
                    if ($ctrl.integration.settings == null) {
                        $ctrl.integration.settings = {};
                    }
                    $ctrl.settingCategoriesArray = Object.entries($ctrl.integration.settingCategories)
                        .map(([categoryName, sc]) => {
                            sc.categoryName = categoryName;
                            sc.settingsArray = [];
                            const settingNames = Object.keys(sc.settings);
                            for (const settingName of settingNames) {
                                const setting = sc.settings[settingName];
                                setting.settingName = settingName;
                                sc.settingsArray.push(setting);
                            }
                            return sc;
                        });
                } else {
                    $ctrl.dismiss();
                }
            };

            $ctrl.resetToDefaults = () => {
                utilityService
                    .showConfirmationModal({
                        title: `Reset To Defaults`,
                        question: `Are you sure you want reset ${$ctrl.integration.name} to default settings?`,
                        confirmLabel: "Reset",
                        confirmBtnType: "btn-danger"
                    })
                    .then((confirmed) => {
                        if (confirmed) {
                            $ctrl.close({
                                $value: {
                                    integrationId: $ctrl.integration.id,
                                    action: "reset"
                                }
                            });
                        }
                    });
            };

            function validate() {
                if ($ctrl.integration.settingCategories) {
                    for (const category of Object.values($ctrl.integration.settingCategories)) {
                        for (const setting of Object.values(category.settings)) {
                            if (setting.validation) {
                                if (setting.validation.required) {
                                    if (setting.type === 'string' && setting.value === "") {
                                        ngToast.create(`Please input a value for the ${setting.title} option`);
                                        return false;
                                    } else if (setting.type === 'editable-list' && (setting.value == null || setting.value.length === 0)) {
                                        ngToast.create(`Please input some text for the ${setting.title} option`);
                                        return false;
                                    } else if (setting.value === null || setting.value === undefined) {
                                        ngToast.create(`Please select/input a value for the ${setting.title} option`);
                                        return false;
                                    }
                                }
                                if (setting.type === "number") {
                                    if (!isNaN(setting.validation.min) && setting.value < setting.validation.min) {
                                        ngToast.create(`The value for the ${setting.title} option must be at least ${setting.validation.min}`);
                                        return false;
                                    }
                                    if (!isNaN(setting.validation.max) && setting.value > setting.validation.max) {
                                        ngToast.create(`The value for the ${setting.title} option must be no more than ${setting.validation.max}`);
                                        return false;
                                    }
                                }
                            }
                        }
                    }
                }
                return true;
            }

            $ctrl.save = () => {
                if (!validate()) {
                    return;
                }

                $ctrl.close({
                    $value: {
                        integration: $ctrl.integration,
                        action: "save"
                    }
                });
            };
        }
    });

    /*
     * Custom rendering for the YouTube integration's "youtube-bot-auth" setting
     * type. Link/Unlink send directly to the backend (the integration persists
     * the bot token via its settings-update mechanism) — this setting is not
     * part of the modal's Save flow.
     */
    angular.module("firebotApp").component("youtubeBotAuthSetting", {
        bindings: {
            schema: "<",
            botChannel: "<"
        },
        template: `
            <div>
                <div class="integrations-list" style="display: flex; justify-content: space-between;">
                    <div style="text-align: center;min-width: 100px;">
                        <div style="display: flex;justify-content: center;align-items: center;min-height: 80px;">
                            <img ng-if="$ctrl.displayChannel != null && $ctrl.displayChannel.avatarUrl" ng-src="{{ $ctrl.displayChannel.avatarUrl }}" width="80" style="border-radius: 5px;" />
                            <span ng-if="$ctrl.displayChannel == null" class="muted" style="font-size: 24px;opacity: 0.7;">
                                <i class="fas fa-user-slash"></i>
                            </span>
                        </div>
                        <b>{{ $ctrl.displayChannel != null ? $ctrl.displayChannel.channelTitle : 'Not linked' }}</b>
                    </div>
                    <div style="display: flex;justify-content: center;align-items: center;">
                        <button type="button" ng-if="!$ctrl.isLinked" class="btn btn-primary" ng-click="$ctrl.linkBotAccount()">
                            <i class="fas fa-link"></i> Link Bot Account
                        </button>
                        <button type="button" ng-if="$ctrl.isLinked" class="btn btn-danger" ng-click="$ctrl.unlinkBotAccount()">
                            <i class="fas fa-unlink"></i> Unlink Bot Account
                        </button>
                    </div>
                </div>
                <div class="muted" ng-if="!$ctrl.isLinked" style="font-size: 12px;padding-top: 5px;">
                    The bot account should be a moderator on your channel.
                </div>
            </div>
        `,
        controller: function(backendCommunicator) {
            const $ctrl = this;

            $ctrl.isLinked = false;
            $ctrl.displayChannel = null;

            $ctrl.$onChanges = function(changes) {
                if (changes.botChannel != null) {
                    $ctrl.displayChannel = changes.botChannel.currentValue;
                    $ctrl.isLinked = $ctrl.displayChannel != null;
                }
            };

            $ctrl.$onInit = function() {
                // Live status updates pushed by the backend after link/unlink.
                backendCommunicator.on("youtube:bot-auth-update", function(data) {
                    if (data == null) {
                        return;
                    }
                    $ctrl.isLinked = data.linked === true;
                    $ctrl.displayChannel = $ctrl.isLinked && data.channel != null ? data.channel : null;
                });
            };

            $ctrl.linkBotAccount = function() {
                backendCommunicator.send("youtube:link-bot-account");
            };

            $ctrl.unlinkBotAccount = function() {
                backendCommunicator.send("youtube:unlink-bot-account");
            };
        }
    });
}());

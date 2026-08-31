import type { EffectType } from "../../../../types/effects";
import { AccountAccess } from "../../../common/account-access";
import { TwitchApi } from "../api";
import { youTubeStreamControl } from "../../../integrations/builtin/youtube/stream-control";

type TitleDestination = "twitch" | "youtube" | "both";

const model: EffectType<{
    title: string;
    destination?: TitleDestination;
}> = {
    definition: {
        id: "firebot:streamtitle",
        name: "Set Stream Title",
        description: "Set the title of the stream.",
        icon: "fad fa-comment-dots",
        categories: ["common", "twitch"],
        dependencies: {
            twitch: true
        }
    },
    optionsTemplate: `
        <eos-container header="New Title" pad-top="true">
            <input ng-model="effect.title" class="form-control" type="text" placeholder="Enter text" replace-variables menu-position="below">
            <p ng-show="trigger == 'command'" class="muted" style="font-size:11px;margin-top:6px;"><b>ProTip:</b> Use <b>$arg[all]</b> to include every word after the command !trigger.</p>
        </eos-container>

        <eos-container header="Destination" pad-top="true">
            <dropdown-select options="{ both: 'Both (Twitch + YouTube)', twitch: 'Twitch Only', youtube: 'YouTube Only' }" selected="effect.destination"></dropdown-select>
            <p class="muted" style="font-size:11px;margin-top:5px;">"Both" updates the title on Twitch and YouTube (while the YouTube integration is connected and live). YouTube has no game/category taxonomy, so the category stays Twitch-only.</p>
        </eos-container>
    `,
    optionsController: ($scope) => {
        // Locked decision D11: title changes sync both platforms by default.
        if ($scope.effect.destination == null) {
            $scope.effect.destination = "both";
        }
    },
    optionsValidator: (effect) => {
        const errors: string[] = [];
        if (effect.title == null) {
            errors.push("Please input the title you'd like to use for the stream.");
        }
        return errors;
    },
    onTriggerEvent: async (event) => {
        const destination: TitleDestination = event.effect.destination ?? "both";
        const title = event.effect.title;

        // Twitch path preserved exactly (D11).
        if (destination === "twitch" || destination === "both") {
            const client = TwitchApi.streamerClient;

            await client.channels.updateChannelInfo(AccountAccess.getAccounts().streamer.userId, {
                title
            });
        }

        // YouTube path: only while the broadcast is live (stream-control warns
        // and no-ops otherwise).
        if (destination === "youtube" || destination === "both") {
            await youTubeStreamControl.updateTitle(title);
        }
        return true;
    }
};

export = model;

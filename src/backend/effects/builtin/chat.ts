import type { EffectType } from "../../../types";
import { LoggerCache } from "../../logger-cache";

import { TwitchApi } from '../../streaming-platforms/twitch/api';
import { platformDispatch, type ChatMessageDestination } from "../../chat/platform-dispatch";

const logger = LoggerCache.getLogger("Effects");

const effect: EffectType<{
    chatter: string;
    message: string;
    me: boolean;
    whisper: string;
    sendAsReply: boolean;
    pin: boolean;
    pinUntilEndOfStream: boolean;
    pinDuration?: string;
    destination?: ChatMessageDestination;
}> = {
    definition: {
        id: "firebot:chat",
        name: "Chat",
        description: "Send a chat message.",
        icon: "fad fa-comment-lines",
        categories: ["common", "chat based", "twitch"],
        dependencies: ["chat"]
    },
    optionsTemplate: `
    <eos-chatter-select effect="effect" title="Chat as"></eos-chatter-select>

    <eos-container header="Destination" pad-top="true">
        <div class="btn-group">
            <button type="button" class="btn btn-default dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
                {{displayDestination()}} <span class="caret"></span>
            </button>
            <ul class="dropdown-menu chat-effect-dropdown">
                <li ng-click="setDestination('both')"><a href>Both</a></li>
                <li ng-click="setDestination('twitch')"><a href>Twitch</a></li>
                <li ng-click="setDestination('youtube')"><a href>YouTube</a></li>
            </ul>
        </div>
        <p class="muted" style="font-size:11px; margin-top:5px;">"Both" sends the message to Twitch and YouTube (while the YouTube integration is connected and live).</p>
    </eos-container>

    <eos-container header="Message To Send" pad-top="true">
        <firebot-input
            model="effect.message"
            use-text-area="true"
            placeholder-text="Enter message"
            rows="4"
            cols="40"
            menu-position="under"
        />
        <div style="color: #fb7373;" ng-if="effect.message && effect.message.length > 500">Chat messages cannot be longer than 500 characters. This message will get automatically chunked into multiple messages if it is too long after all replace variables have been populated.</div>
        <p class="muted" style="font-size:11px;" ng-if="effect.destination !== 'twitch'">YouTube chat messages are capped at ~200 characters; anything longer is truncated with an ellipsis.</p>
        <div style="display: flex; flex-direction: row; width: 100%; height: 36px; margin: 10px 0 10px; align-items: center;">
            <firebot-checkbox
                label="Use '/me'"
                tooltip="Applies Italics to your Chat Message or your Chat Color if used in a Whisper. Ignored on YouTube (sent as the raw text)."
                model="effect.me"
                style="margin: 0px 15px 0px 0px"
            />
            <firebot-checkbox
                label="Whisper"
                tooltip="Whispers only send to Twitch (YouTube has no whisper API)"
                model="showWhisperInput"
                style="margin: 0px 15px 0px 0px"
                ng-click="effect.whisper = ''"
            />
            <div ng-show="showWhisperInput">
                <firebot-input
                    input-title="To"
                    model="effect.whisper"
                    placeholder-text="Username"
                    force-input="true"
                />
            </div>
        </div>
        <p ng-show="effect.whisper" class="muted" style="font-size:11px;"><b>ProTip:</b> To whisper the associated user, put <b>$user</b> in the whisper field.</p>
        <div ng-hide="effect.whisper">
            <firebot-checkbox
                label="Send as reply"
                tooltip="Replying only works within a Command or Chat Message event. Replies only apply to Twitch; YouTube has no reply threading in v1."
                model="effect.sendAsReply"
                style="margin: 0px 15px 0px 0px"
            />
        </div>
    </eos-container>

    <eos-container header="Pin Message" pad-top="true" ng-hide="effect.whisper || effect.destination === 'youtube'">
        <div style="display: flex; flex-direction: row; width: 100%; margin: 0 0 10px 0; align-items: center;">
            <firebot-checkbox
                label="Pin message"
                tooltip="Pin message to the top of chat (Twitch only)"
                model="effect.pin"
                style="margin: 0px 15px 0px 0px"
            />
            <firebot-checkbox
                ng-show="effect.pin === true"
                label="Pin until end of stream"
                model="effect.pinUntilEndOfStream"
                style="margin: 0px 15px 0px 0px"
            />
        </div>
        <firebot-input
            ng-show="effect.pin === true && effect.pinUntilEndOfStream !== true"
            model="effect.pinDuration"
            input-title="Duration (in secs)"
            placeholder-text="Enter duration"
        />
    </eos-container>

    `,
    optionsController: ($scope) => {
        $scope.showWhisperInput = $scope.effect.whisper != null && $scope.effect.whisper !== '';

        // Locked decision D7: chat messages default to both platforms.
        if ($scope.effect.destination == null) {
            $scope.effect.destination = "both";
        }

        $scope.setDestination = (destination: ChatMessageDestination) => {
            $scope.effect.destination = destination;
        };

        $scope.displayDestination = () => {
            const destination = $scope.effect.destination ?? "both";
            return destination.charAt(0).toUpperCase() + destination.slice(1);
        };
    },
    optionsValidator: (effect) => {
        const errors: string[] = [];
        if (effect.message == null || effect.message === "") {
            errors.push("Chat message can't be blank.");
        }
        if (effect.whisper && effect.destination === "youtube") {
            errors.push("Whispers can only be sent to Twitch (YouTube has no whisper API).");
        }
        if (effect.pin === true
            && effect.pinUntilEndOfStream !== true
            && !effect.pinDuration?.length
        ) {
            errors.push("Must choose pin duration");
        }
        return errors;
    },
    onTriggerEvent: async ({ effect, trigger }) => {
        const destination: ChatMessageDestination = effect.destination ?? "both";

        let messageId: string = null;
        if (trigger.type === "command") {
            messageId = trigger.metadata.chatMessage.id;
        } else if (trigger.type === "event") {
            messageId = trigger.metadata.eventData?.chatMessage?.id;
        }

        // Whispers are Twitch-only: there is no YouTube API for them.
        if (effect.whisper) {
            const user = await TwitchApi.users.getUserByName(effect.whisper);

            const whisperMessage = effect.me ? `/me ${effect.message}` : effect.message;

            // We default to sending as the bot unless the user specifies otherwise
            await TwitchApi.whispers.sendWhisper(user.id, whisperMessage, effect.chatter == null || effect.chatter.toLowerCase() === "bot");

            return true;
        }

        // The Twitch transport consumes the message (slash commands, /me italics,
        // 500-char chunking); the YouTube side receives the raw text with any
        // "/me" prefix stripped by the dispatch layer.
        const twitchMessage = effect.me ? `/me ${effect.message}` : effect.message;

        const sendResult = await platformDispatch.sendChatMessage(twitchMessage, {
            destination,
            accountType: effect.chatter ?? "Bot",
            replyToMessageId: effect.sendAsReply === true ? messageId : null
        });

        if (effect.pin === true) {
            if (sendResult.twitch.attempted === true && sendResult.twitch.success === true) {
                if (sendResult.twitch.isSlashCommand !== true) {
                    let pinDuration: number = undefined;

                    if (effect.pinUntilEndOfStream !== true
                        && !!effect.pinDuration?.length
                    ) {
                        pinDuration = Number(effect.pinDuration);

                        if (isNaN(pinDuration)) {
                            pinDuration = undefined;
                        } else if (pinDuration < 30) {
                            pinDuration = 30;
                        } else if (pinDuration > 1800) {
                            pinDuration = 1800;
                        }
                    }

                    await TwitchApi.chat.pinChatMessage(sendResult.twitch.messageId, pinDuration);
                } else {
                    logger.warn("Chat message not pinned due to being processed as slash command");
                }
            } else if (sendResult.twitch.attempted === true || destination !== "youtube") {
                logger.warn("Message failed to send. Unable to pin.");
            }
        }

        return true;
    }
};

export = effect;
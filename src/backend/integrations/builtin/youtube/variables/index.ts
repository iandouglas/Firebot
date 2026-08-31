import type { ReplaceVariable } from "../../../../../types/variables";
import { ReplaceVariableManager } from "../../../../variables/replace-variable-manager";

import youtubeViewerCount from "./youtube-viewer-count";
import superChatAmount from "./super-chat-amount";
import superChatCurrency from "./super-chat-currency";
import superChatTier from "./super-chat-tier";
import superChatMessage from "./super-chat-message";
import memberLevelName from "./member-level-name";
import memberMonth from "./member-month";
import memberIsUpgrade from "./member-is-upgrade";
import giftedMembershipCount from "./gifted-membership-count";

/**
 * WS-7 YouTube replace variables. Aggregated here as a plain array (mirroring
 * src/backend/streaming-platforms/twitch/variables/index.ts) and registered by
 * registerYouTubeVariables() — the youtube event source's module init registers
 * them, so no change to src/backend/variables/variable-loader.ts is needed.
 */
const youTubeVariables: ReplaceVariable[] = [
    youtubeViewerCount,
    superChatAmount,
    superChatCurrency,
    superChatTier,
    superChatMessage,
    memberLevelName,
    memberMonth,
    memberIsUpgrade,
    giftedMembershipCount
];

export default youTubeVariables;
export { youTubeVariables };

export const variableHandles = youTubeVariables.map(v => v.definition.handle);

/**
 * Registers all youtube variables with the ReplaceVariableManager. Assumes each
 * handle is registered at most once per app run (the caller is idempotent).
 */
export function registerYouTubeVariables(): void {
    for (const definition of youTubeVariables) {
        ReplaceVariableManager.registerReplaceVariable(definition);
    }
}
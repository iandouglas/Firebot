import type { ReplaceVariable, TriggersObject } from "../../../../../types/variables";

/**
 * $superChatTier — the YouTube tier (level 1-7) of the super chat / super
 * sticker purchase. Tiers map to message highlight styling on YouTube's side.
 * Returns null outside a YouTube super chat/sticker event or when YouTube
 * reports no tier.
 */
const triggers: TriggersObject = {};
triggers["event"] = ["youtube:super-chat", "youtube:super-sticker"];
triggers["manual"] = true;

const model: ReplaceVariable = {
    definition: {
        handle: "superChatTier",
        description: "The tier (1-7) of the super chat or super sticker purchase.",
        triggers: triggers,
        categories: ["common", "trigger based"],
        possibleDataOutput: ["number", "null"]
    },
    evaluator: (trigger) => {
        const eventData = (trigger.metadata?.eventData ?? {}) as Record<string, unknown>;
        const tier = eventData.superChatTier;
        if (tier == null) {
            return null;
        }
        const value = Number(tier);
        return isNaN(value) ? null : value;
    }
};

export default model;
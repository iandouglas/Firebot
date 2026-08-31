import type { ReplaceVariable, TriggersObject } from "../../../../../types/variables";

/**
 * $superChatAmount — the formatted purchase amount of a super chat / super
 * sticker as a display string (e.g. "$5.00"), exactly as YouTube reports it.
 * Returns null outside a YouTube super chat/sticker event.
 */
const triggers: TriggersObject = {};
triggers["event"] = ["youtube:super-chat", "youtube:super-sticker"];
triggers["manual"] = true;

const model: ReplaceVariable = {
    definition: {
        handle: "superChatAmount",
        description: "The formatted amount of the super chat or super sticker (e.g. $5.00).",
        triggers: triggers,
        categories: ["common", "trigger based"],
        possibleDataOutput: ["text", "null"]
    },
    evaluator: (trigger) => {
        const eventData = (trigger.metadata?.eventData ?? {}) as Record<string, unknown>;
        return (eventData.superChatAmountDisplay as string | null) ?? null;
    }
};

export default model;
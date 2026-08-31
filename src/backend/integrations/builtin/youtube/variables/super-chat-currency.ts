import type { ReplaceVariable, TriggersObject } from "../../../../../types/variables";

/**
 * $superChatCurrency — the ISO 4217 currency code (e.g. "USD") of a super chat
 * / super sticker purchase. Returns null outside a YouTube super chat/sticker
 * event.
 */
const triggers: TriggersObject = {};
triggers["event"] = ["youtube:super-chat", "youtube:super-sticker"];
triggers["manual"] = true;

const model: ReplaceVariable = {
    definition: {
        handle: "superChatCurrency",
        description: "The currency code of the super chat or super sticker purchase (e.g. USD).",
        triggers: triggers,
        categories: ["common", "trigger based"],
        possibleDataOutput: ["text", "null"]
    },
    evaluator: (trigger) => {
        const eventData = (trigger.metadata?.eventData ?? {}) as Record<string, unknown>;
        return (eventData.superChatCurrency as string | null) ?? null;
    }
};

export default model;
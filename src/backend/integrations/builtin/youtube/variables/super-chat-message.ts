import type { ReplaceVariable, TriggersObject } from "../../../../../types/variables";

/**
 * $superChatMessage — the message accompanying a YouTube super chat (empty
 * string for super stickers — they carry no comment, and YouTube reports none).
 * Mirrors the twitch subMessage convention of an empty-string fallback.
 */
const triggers: TriggersObject = {};
triggers["event"] = ["youtube:super-chat", "youtube:super-sticker"];
triggers["manual"] = true;

const model: ReplaceVariable = {
    definition: {
        handle: "superChatMessage",
        description: "The message included with a super chat (empty for super stickers).",
        triggers: triggers,
        categories: ["common", "trigger based"],
        possibleDataOutput: ["text"]
    },
    evaluator: (trigger) => {
        const eventData = (trigger.metadata?.eventData ?? {}) as Record<string, unknown>;
        return (eventData.superChatMessage as string | null) ?? "";
    }
};

export default model;
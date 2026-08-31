import type { ReplaceVariable, TriggersObject } from "../../../../../types/variables";

/**
 * $memberLevelName — the YouTube membership level name (e.g. "Member") from a
 * member join, member milestone, or gifted-membership event. Returns null
 * outside a YouTube membership event.
 */
const triggers: TriggersObject = {};
triggers["event"] = [
    "youtube:member-join",
    "youtube:member-milestone",
    "youtube:gift-membership",
    "youtube:gift-membership-received"
];
triggers["manual"] = true;

const model: ReplaceVariable = {
    definition: {
        handle: "memberLevelName",
        description: "The YouTube membership level name of the member event.",
        triggers: triggers,
        categories: ["common", "trigger based"],
        possibleDataOutput: ["text", "null"]
    },
    evaluator: (trigger) => {
        const eventData = (trigger.metadata?.eventData ?? {}) as Record<string, unknown>;
        return (eventData.memberLevelName as string | null) ?? null;
    }
};

export default model;
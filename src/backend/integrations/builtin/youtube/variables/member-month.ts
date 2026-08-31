import type { ReplaceVariable, TriggersObject } from "../../../../../types/variables";

/**
 * $memberMonth — the milestone month a YouTube member has reached (e.g. 12).
 * Returns null outside a youtube:member-milestone event.
 */
const triggers: TriggersObject = {};
triggers["event"] = ["youtube:member-milestone"];
triggers["manual"] = true;

const model: ReplaceVariable = {
    definition: {
        handle: "memberMonth",
        description: "The milestone month reached by a YouTube channel member.",
        triggers: triggers,
        categories: ["common", "trigger based"],
        possibleDataOutput: ["number", "null"]
    },
    evaluator: (trigger) => {
        const eventData = (trigger.metadata?.eventData ?? {}) as Record<string, unknown>;
        const month = eventData.memberMonth;
        if (month == null) {
            return null;
        }
        const value = Number(month);
        return isNaN(value) ? null : value;
    }
};

export default model;
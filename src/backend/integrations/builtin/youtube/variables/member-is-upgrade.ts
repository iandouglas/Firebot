import type { ReplaceVariable, TriggersObject } from "../../../../../types/variables";

/**
 * $memberIsUpgrade — whether a YouTube member milestone is a membership level
 * upgrade (true/false on member events; YouTube does not report an upgrade
 * flag on every message, in which case false is assumed in context). Returns
 * null outside YouTube member events.
 */
const triggers: TriggersObject = {};
triggers["event"] = ["youtube:member-join", "youtube:member-milestone"];
triggers["manual"] = true;

const model: ReplaceVariable = {
    definition: {
        handle: "memberIsUpgrade",
        description: "Whether the YouTube member milestone is a level upgrade.",
        triggers: triggers,
        categories: ["common", "trigger based"],
        possibleDataOutput: ["bool", "null"]
    },
    evaluator: (trigger) => {
        const eventData = (trigger.metadata?.eventData ?? {}) as Record<string, unknown>;
        const isUpgrade = eventData.memberIsUpgrade;
        return typeof isUpgrade === "boolean" ? isUpgrade : null;
    }
};

export default model;
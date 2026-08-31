import type { ReplaceVariable, TriggersObject } from "../../../../../types/variables";

/**
 * $giftedMembershipCount — the number of YouTube channel memberships gifted in
 * one gifting message (the message author is the gifter). Returns 0 outside a
 * youtube:gift-membership event, mirroring the twitch giftCount convention.
 */
const triggers: TriggersObject = {};
triggers["event"] = ["youtube:gift-membership"];
triggers["manual"] = true;

const model: ReplaceVariable = {
    definition: {
        handle: "giftedMembershipCount",
        description: "The number of YouTube memberships gifted in the gift event.",
        triggers: triggers,
        categories: ["common", "trigger based"],
        possibleDataOutput: ["number"]
    },
    evaluator: (trigger) => {
        const eventData = (trigger.metadata?.eventData ?? {}) as Record<string, unknown>;
        return eventData.giftCount || 0;
    }
};

export default model;
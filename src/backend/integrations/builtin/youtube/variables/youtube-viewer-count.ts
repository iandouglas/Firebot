import type { ReplaceVariable, TriggersObject } from "../../../../../types/variables";

/**
 * $youtubeViewerCount — the concurrent viewer count of the live YouTube
 * broadcast. Populated on the "youtube:stream-online" event (WS-2 includes the
 * count from its videos.list piggyback). Accepts both the documented
 * `viewerCount` metadata key and WS-2's `concurrentViewers` (raw API string).
 * Returns null outside YouTube stream-online context.
 */
const triggers: TriggersObject = {};
triggers["event"] = ["youtube:stream-online"];
triggers["manual"] = true;

const model: ReplaceVariable = {
    definition: {
        handle: "youtubeViewerCount",
        description: "The current number of concurrent viewers on the YouTube live broadcast.",
        triggers: triggers,
        categories: ["common", "trigger based"],
        possibleDataOutput: ["number", "null"]
    },
    evaluator: (trigger) => {
        const eventData = (trigger.metadata?.eventData ?? {}) as Record<string, unknown>;
        const raw = eventData.viewerCount ?? eventData.concurrentViewers;
        if (raw == null) {
            return null;
        }

        const value = typeof raw === "number" ? raw : parseInt(String(raw), 10);
        return isNaN(value) ? null : value;
    }
};

export default model;
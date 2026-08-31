import { EventManager } from "../../../../events/event-manager";

import { youTubeEventSource } from "./event-definitions";
import { subscribeYouTubeIngestEvents } from "./event-handler";
import { registerYouTubeVariables } from "../variables";

let registered = false;

/**
 * WS-7 module entry point, called once from the YouTube integration's init()
 * (same pattern as Streamlabs' `registerEvents()` and ExtraLife's
 * `registerVariables()`):
 *
 * 1. registers the "youtube" event source with the EventManager so the events
 *    appear in the Events UI (with manualMetadata for test-firing and
 *    activityFeed entries),
 * 2. subscribes the ingest → event mapping to the shared `youtubeChatEvents`
 *    emitter, and
 * 3. registers the youtube replace variables with the ReplaceVariableManager.
 *
 * Idempotent — integration-manager may init the integration more than once.
 */
export function registerYouTubeEvents(): void {
    if (registered) {
        return;
    }
    registered = true;

    EventManager.registerEventSource(youTubeEventSource);
    subscribeYouTubeIngestEvents();
    registerYouTubeVariables();
}
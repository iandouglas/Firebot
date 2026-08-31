/**
 * WS-2 chat-ingest stub contract lock: the live monitor (and its tests) depend
 * on these EXACT exported signatures surviving WS-4's implementation. The stub
 * must be a harmless no-op until WS-4 lands.
 */

import { startChatIngest, stopChatIngest } from "../chat-ingest";

describe("chat-ingest stub contract (WS-4 handoff)", () => {
    it("exports startChatIngest with the locked signature (liveChatId, videoId) -> void", () => {
        expect(typeof startChatIngest).toBe("function");
        expect(startChatIngest.length).toBe(2);
    });

    it("exports stopChatIngest with the locked signature () -> void", () => {
        expect(typeof stopChatIngest).toBe("function");
        expect(stopChatIngest.length).toBe(0);
    });

    it("both are safe no-ops until WS-4 implements them", () => {
        expect(() => startChatIngest("chat-1", "video-1")).not.toThrow();
        expect(() => stopChatIngest()).not.toThrow();
        expect(() => stopChatIngest()).not.toThrow(); // idempotent by contract
        expect(startChatIngest("chat-1", "video-1")).toBeUndefined();
        expect(stopChatIngest()).toBeUndefined();
    });
});
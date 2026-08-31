/**
 * WS-2 stream event triggers: exact metadata fired on the "youtube" event
 * source (D8: youtube:* ids, never twitch:*). EventManager is mocked — no
 * real event loading happens here (WS-7 owns the event source definitions).
 */

jest.mock("../../../../events/event-manager", () => ({
    __esModule: true,
    EventManager: {
        triggerEvent: jest.fn()
    }
}));

import { EventManager } from "../../../../events/event-manager";
import { triggerStreamOffline, triggerStreamOnline } from "../triggers/stream-events";

const mockedTriggerEvent = (EventManager.triggerEvent as unknown) as jest.Mock;

const CHANNEL = {
    channelId: "UCfakeStreamerChannelId123",
    channelTitle: "Fake Firebot Streamer"
};

beforeEach(() => {
    mockedTriggerEvent.mockReset();
    mockedTriggerEvent.mockResolvedValue(undefined);
});

describe("stream event triggers", () => {
    it("stream-online fires on the youtube source with channel identity + stream context", () => {
        triggerStreamOnline(CHANNEL, {
            videoId: "video-1",
            liveChatId: "chat-1",
            concurrentViewers: 1337,
            startedAt: "2025-10-01T18:05:00Z"
        });

        expect(mockedTriggerEvent).toHaveBeenCalledTimes(1);
        expect(mockedTriggerEvent).toHaveBeenCalledWith("youtube", "stream-online", {
            username: "Fake Firebot Streamer",
            userId: "UCfakeStreamerChannelId123",
            userDisplayName: "Fake Firebot Streamer",
            videoId: "video-1",
            liveChatId: "chat-1",
            concurrentViewers: 1337,
            startedAt: "2025-10-01T18:05:00Z"
        });
    });

    it("stream-offline fires on the youtube source with channel identity only", () => {
        triggerStreamOffline(CHANNEL);

        expect(mockedTriggerEvent).toHaveBeenCalledTimes(1);
        expect(mockedTriggerEvent).toHaveBeenCalledWith("youtube", "stream-offline", {
            username: "Fake Firebot Streamer",
            userId: "UCfakeStreamerChannelId123",
            userDisplayName: "Fake Firebot Streamer"
        });
    });

    it("never emits twitch:* ids (locked decision D8)", () => {
        triggerStreamOnline(CHANNEL, { videoId: "video-1", liveChatId: null, concurrentViewers: null, startedAt: null });
        triggerStreamOffline(CHANNEL);

        const sourceIds = mockedTriggerEvent.mock.calls.map(call => call[0]);
        expect(sourceIds).toEqual(["youtube", "youtube"]);
    });
});
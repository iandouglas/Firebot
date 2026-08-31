/**
 * WS-8: stream-title effect destination routing — default "both" (D11),
 * Twitch-only, YouTube-only, and the YouTube path delegating to
 * stream-control.updateTitle while the Twitch path stays identical.
 */

jest.mock("../src/backend/common/account-access", () => ({
    AccountAccess: {
        getAccounts: () => ({
            streamer: { userId: "twitch-streamer-id" }
        })
    }
}));

jest.mock("../src/backend/streaming-platforms/twitch/api", () => ({
    TwitchApi: {
        streamerClient: {
            channels: {
                updateChannelInfo: jest.fn()
            }
        }
    }
}));

jest.mock("../src/backend/integrations/builtin/youtube/stream-control", () => ({
    youTubeStreamControl: {
        updateTitle: jest.fn()
    }
}));

import effect from "../src/backend/streaming-platforms/twitch/effects/stream-title";
import { TwitchApi } from "../src/backend/streaming-platforms/twitch/api";
import { youTubeStreamControl } from "../src/backend/integrations/builtin/youtube/stream-control";

const mockUpdateChannelInfo = (TwitchApi.streamerClient.channels.updateChannelInfo as unknown) as jest.Mock;
const mockYtUpdateTitle = (youTubeStreamControl.updateTitle as unknown) as jest.Mock;

const fire = effect.onTriggerEvent as (context: { effect: unknown }) => Promise<boolean>;

type EffectModel = {
    title: string;
    destination?: "twitch" | "youtube" | "both";
};

function makeEffect(overrides: Partial<EffectModel> = {}): EffectModel {
    return {
        title: "My Stream Title",
        ...overrides
    } as EffectModel;
}

beforeEach(() => {
    mockUpdateChannelInfo.mockResolvedValue(undefined);
    mockYtUpdateTitle.mockResolvedValue({ success: true });
});

describe("stream-title effect destination routing", () => {
    it("defaults to both platforms (locked decision D11)", async () => {
        const result = await fire({ effect: makeEffect() });

        expect(result).toBe(true);
        expect(mockUpdateChannelInfo).toHaveBeenCalledWith("twitch-streamer-id", { title: "My Stream Title" });
        expect(mockYtUpdateTitle).toHaveBeenCalledWith("My Stream Title");
    });

    it("updates only Twitch for a twitch-only destination", async () => {
        await fire({ effect: makeEffect({ destination: "twitch" }) });

        expect(mockUpdateChannelInfo).toHaveBeenCalledTimes(1);
        expect(mockYtUpdateTitle).not.toHaveBeenCalled();
    });

    it("updates only YouTube for a youtube-only destination", async () => {
        await fire({ effect: makeEffect({ destination: "youtube" }) });

        expect(mockYtUpdateTitle).toHaveBeenCalledWith("My Stream Title");
        expect(mockUpdateChannelInfo).not.toHaveBeenCalled();
    });

    it("updates both platforms for an explicit both destination", async () => {
        await fire({ effect: makeEffect({ destination: "both" }) });

        expect(mockUpdateChannelInfo).toHaveBeenCalledTimes(1);
        expect(mockYtUpdateTitle).toHaveBeenCalledTimes(1);
    });
});

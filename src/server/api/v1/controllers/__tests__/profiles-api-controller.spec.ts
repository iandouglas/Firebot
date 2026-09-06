/**
 * WS-11 follow-up: profile-switch HTTP endpoint (Stream Deck / external callers).
 * Unit tests for profiles-api-controller.switchProfile — all collaborators mocked,
 * no network, no electron.
 */

jest.mock("../../../../../backend/common/profile-manager", () => ({
    ProfileManager: {
        logInProfile: jest.fn()
    }
}));

jest.mock("../../../../../backend/common/settings-manager", () => ({
    SettingsManager: {
        getSetting: jest.fn()
    }
}));

import { Request, Response } from "express";
import { ProfileManager } from "../../../../../backend/common/profile-manager";
import { SettingsManager } from "../../../../../backend/common/settings-manager";
import { switchProfile } from "../profiles-api-controller";

const mockLogInProfile = ProfileManager.logInProfile as unknown as jest.Mock;
const mockGetSetting = SettingsManager.getSetting as unknown as jest.Mock;

function makeRes(): Response {
    return {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
    } as unknown as Response;
}

function makeReq(profileId?: string): Request {
    return { params: { profileId } } as unknown as Request;
}

describe("profiles-api-controller switchProfile", () => {
    beforeEach(() => {
        mockLogInProfile.mockReset();
        mockGetSetting.mockReset();
    });

    it("switches to a known profile and returns success", () => {
        mockGetSetting.mockReturnValue(["aiDevCo", "TheInterviewGuide"]);
        const req = makeReq("aiDevCo");
        const res = makeRes();

        switchProfile(req, res);

        expect(mockLogInProfile).toHaveBeenCalledWith("aiDevCo");
        expect(res.status).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith({ success: true, profileId: "aiDevCo" });
    });

    it("rejects a missing profileId with 400", () => {
        const req = makeReq(undefined);
        const res = makeRes();

        switchProfile(req, res);

        expect(mockLogInProfile).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ success: false, error: "profileId is required" });
    });

    it("rejects an unknown profile with 404", () => {
        mockGetSetting.mockReturnValue(["aiDevCo"]);
        const req = makeReq("nope");
        const res = makeRes();

        switchProfile(req, res);

        expect(mockLogInProfile).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({ success: false, error: "Unknown profile: nope" });
    });

    it("returns 500 when logInProfile throws", () => {
        mockGetSetting.mockReturnValue(["aiDevCo"]);
        mockLogInProfile.mockImplementation(() => {
            throw new Error("boom");
        });
        const req = makeReq("aiDevCo");
        const res = makeRes();

        switchProfile(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ success: false, error: "boom" });
    });
});

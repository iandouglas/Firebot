import { Request, Response } from "express";
import { ProfileManager } from "../../../../backend/common/profile-manager";
import { SettingsManager } from "../../../../backend/common/settings-manager";

/**
 * Switch the active Firebot profile (used by Stream Deck / external HTTP callers).
 *
 * Validates the profileId against the active-profiles list before switching so a
 * bad URL can't restart Firebot into a non-existent profile. On success the app
 * restarts into the target profile (the same behavior as the in-app profile
 * switcher). The JSON response is sent before the scheduled restart.
 */
export function switchProfile(req: Request, res: Response): void {
    const profileId = req.params.profileId;

    if (profileId == null || profileId === "") {
        res.status(400).json({ success: false, error: "profileId is required" });
        return;
    }

    const activeProfiles: string[] = SettingsManager.getSetting("ActiveProfiles") ?? [];
    if (!activeProfiles.includes(profileId)) {
        res.status(404).json({ success: false, error: `Unknown profile: ${profileId}` });
        return;
    }

    try {
        ProfileManager.logInProfile(profileId);
        res.json({ success: true, profileId });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error)?.message ?? String(error) });
    }
}

export interface FirebotViewer {
    _id: string;
    /**
     * Which platform the viewer record belongs to. Absent on records created before
     * the "<platform>:<user_id>" re-key; the viewer database stamps these on startup.
     */
    platform?: "twitch" | "youtube";
    username: string;
    displayName: string;
    profilePicUrl: string;
    twitch: boolean;
    twitchRoles: string[];
    online: boolean;
    onlineAt: number;
    lastSeen: number;
    joinDate: number;
    minutesInChannel: number;
    chatMessages: number;
    disableAutoStatAccrual: boolean;
    disableActiveUserList: boolean;
    disableViewerList: boolean;
    metadata: Record<string, unknown>;
    currency: Record<string, number>;
    ranks: Record<string, string>;
}

export interface BasicViewer {
    id: string;
    username: string;
    displayName?: string;
    twitchRoles?: string[];
    profilePicUrl?: string;
}

export type NewFirebotViewer = BasicViewer & Partial<Omit<FirebotViewer, "_id" | "username" | "displayName" | "twitchRoles" | "profilePicUrl">>;

export type FrontendViewer = {
    id: string;
    username: string;
    displayName: string;
    roles: string[];
    profilePicUrl: string;
    active: boolean;
    disableViewerList?: boolean;
    /**
     * Which platform the viewer is present on. Absent/null = "twitch" (legacy
     * behavior). Set by the YouTube chat ingest (WS-4) so the Chat Users panel
     * (WS-10) can render a platform category/badge.
     */
    platform?: "twitch" | "youtube";
};
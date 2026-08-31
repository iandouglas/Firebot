/**
 * WS-4: chat message mapper — the ONLY place raw `liveChatMessages.list` items
 * are decoded into the shared `YouTubeIngestMessage` contract, and the shared
 * ingest message is rendered as a `FirebotChatMessage`.
 *
 * Exhaustive over the snippet types we intentionally handle; unknown types map
 * to no message and never throw. No network, no collaborators.
 */

import type { YouTubeChatMessageItem } from "../contracts";
import {
    ingestMessageToFirebotChatMessage,
    mapChatItemToIngestMessage,
    type MappedChatItem
} from "../chat-message-mapper";

function item(overrides: Partial<YouTubeChatMessageItem> = {}): YouTubeChatMessageItem {
    return {
        id: "msg-1",
        type: "textMessageEvent",
        publishedAt: "2026-01-01T12:00:00Z",
        displayMessage: "hello",
        authorChannelId: "UCviewer",
        author: {
            channelId: "UCviewer",
            displayName: "Viewer",
            avatarUrl: "https://example.com/avatar.png",
            isVerified: false,
            isChatOwner: false,
            isChatModerator: false,
            isChatSponsor: false
        },
        details: { textMessageDetails: { messageText: "hello" } },
        ...overrides
    };
}

function expectNoMessage(result: MappedChatItem): void {
    expect(result.message).toBeNull();
    expect(result.membersOnlyMode).toBeNull();
    expect(result.chatEnded).toBe(false);
}

describe("mapChatItemToIngestMessage — snippet type coverage", () => {
    it("maps textMessageEvent to the text kind with author + text", () => {
        const result = mapChatItemToIngestMessage(item());
        expect(result.message).toMatchObject({
            kind: "text",
            messageId: "msg-1",
            publishedAt: "2026-01-01T12:00:00Z",
            text: "hello",
            author: {
                channelId: "UCviewer",
                displayName: "Viewer",
                avatarUrl: "https://example.com/avatar.png",
                isOwner: false,
                isModerator: false,
                isSponsor: false
            }
        });
    });

    it("maps superChatEvent to super-chat with amount payload", () => {
        const result = mapChatItemToIngestMessage(item({
            type: "superChatEvent",
            displayMessage: "Great stream!",
            details: {
                superChatDetails: {
                    amountDisplayString: "$5.00",
                    amountMicros: "5000000",
                    currency: "USD",
                    tier: 2
                }
            }
        }));
        expect(result.message).toMatchObject({
            kind: "super-chat",
            text: "Great stream!",
            payload: {
                superChatAmountDisplay: "$5.00",
                superChatAmountMicros: "5000000",
                superChatCurrency: "USD",
                superChatTier: 2
            }
        });
    });

    it("maps superStickerEvent to super-sticker (no user comment)", () => {
        const result = mapChatItemToIngestMessage(item({
            type: "superStickerEvent",
            displayMessage: "",
            details: {
                superStickerDetails: {
                    amountDisplayString: "$2.00",
                    amountMicros: "2000000",
                    currency: "USD",
                    tier: 1
                }
            }
        }));
        expect(result.message).toMatchObject({ kind: "super-sticker" });
        expect(result.message?.text).toBeUndefined();
        expect(result.message?.payload).toMatchObject({ superChatAmountDisplay: "$2.00" });
    });

    it("maps newSponsorEvent to member-join with level + upgrade flag", () => {
        const result = mapChatItemToIngestMessage(item({
            type: "newSponsorEvent",
            displayMessage: "",
            details: {
                newSponsorDetails: { memberLevelName: "Member", isUpgrade: true }
            }
        }));
        expect(result.message).toMatchObject({
            kind: "member-join",
            payload: { memberLevelName: "Member", isUpgrade: true }
        });
    });

    it("maps memberMilestoneChatEvent to member-milestone with month + level", () => {
        const result = mapChatItemToIngestMessage(item({
            type: "memberMilestoneChatEvent",
            displayMessage: "12 months!",
            details: {
                memberMilestoneChatDetails: { memberLevelName: "Member", memberMonth: 12 }
            }
        }));
        expect(result.message).toMatchObject({
            kind: "member-milestone",
            text: "12 months!",
            payload: { memberLevelName: "Member", memberMonth: 12 }
        });
    });

    it("maps membershipGiftingEvent to gift-membership with count + level", () => {
        const result = mapChatItemToIngestMessage(item({
            type: "membershipGiftingEvent",
            displayMessage: "",
            details: {
                membershipGiftingDetails: { giftMembershipCount: 5, memberLevelName: "Member" }
            }
        }));
        expect(result.message).toMatchObject({
            kind: "gift-membership",
            payload: { giftCount: 5, memberLevelName: "Member" }
        });
    });

    it("maps giftMembershipReceivedEvent to gift-membership-received with gifter channel id", () => {
        const result = mapChatItemToIngestMessage(item({
            type: "giftMembershipReceivedEvent",
            displayMessage: "",
            details: {
                giftMembershipReceivedDetails: { gifterChannelId: "UCgifter", memberLevelName: "Member" }
            }
        }));
        expect(result.message).toMatchObject({
            kind: "gift-membership-received",
            payload: { gifterChannelId: "UCgifter", memberLevelName: "Member" }
        });
    });

    it("maps tombstone to the banned kind", () => {
        const result = mapChatItemToIngestMessage(item({ type: "tombstone", displayMessage: "" }));
        expect(result.message).toMatchObject({ kind: "banned" });
    });

    it("surfaces sponsorOnlyModeStartedEvent as membersOnlyMode started (no ingest kind)", () => {
        const result = mapChatItemToIngestMessage(item({ type: "sponsorOnlyModeStartedEvent", displayMessage: "" }));
        expect(result.membersOnlyMode).toBe("started");
        expect(result.message).toBeNull();
    });

    it("surfaces sponsorOnlyModeEndedEvent as membersOnlyMode ended", () => {
        const result = mapChatItemToIngestMessage(item({ type: "sponsorOnlyModeEndedEvent", displayMessage: "" }));
        expect(result.membersOnlyMode).toBe("ended");
        expect(result.message).toBeNull();
    });

    it("flags chatEndedEvent as chatEnded", () => {
        const result = mapChatItemToIngestMessage(item({ type: "chatEndedEvent", displayMessage: "" }));
        expect(result.chatEnded).toBe(true);
        expect(result.message).toBeNull();
    });

    it("maps unknown snippet types to no message without throwing", () => {
        expectNoMessage(mapChatItemToIngestMessage(item({ type: "someFutureEvent", displayMessage: "" })));
    });

    it("maps items without an id to no message", () => {
        expectNoMessage(mapChatItemToIngestMessage(item({ id: "" })));
        expectNoMessage(mapChatItemToIngestMessage(undefined as unknown as YouTubeChatMessageItem));
    });

    it("omits payload keys YouTube did not supply", () => {
        const result = mapChatItemToIngestMessage(item({
            type: "superChatEvent",
            displayMessage: "",
            details: { superChatDetails: { amountDisplayString: "$5.00" } }
        }));
        expect(result.message?.payload).toEqual({ superChatAmountDisplay: "$5.00" });
        expect(result.message?.payload?.superChatCurrency).toBeUndefined();
    });
});

describe("ingestMessageToFirebotChatMessage", () => {
    const baseIngest = {
        kind: "text" as const,
        messageId: "msg-1",
        publishedAt: "2026-01-01T12:00:00Z",
        text: "hello @Bob!",
        author: {
            channelId: "UCviewer",
            displayName: "Viewer",
            avatarUrl: "https://example.com/avatar.png",
            isOwner: false,
            isModerator: false,
            isSponsor: false
        }
    };

    it("returns null for non-text kinds", () => {
        expect(ingestMessageToFirebotChatMessage({ ...baseIngest, kind: "super-chat" })).toBeNull();
        expect(ingestMessageToFirebotChatMessage({ ...baseIngest, kind: "member-join" })).toBeNull();
        expect(ingestMessageToFirebotChatMessage({ ...baseIngest, kind: "banned" })).toBeNull();
    });

    it("returns null for text messages without a text string", () => {
        expect(ingestMessageToFirebotChatMessage({ ...baseIngest, text: undefined })).toBeNull();
    });

    it("maps a text message to a FirebotChatMessage with platform youtube and RAW userId", () => {
        const msg = ingestMessageToFirebotChatMessage(baseIngest);
        expect(msg).toMatchObject({
            id: "msg-1",
            platform: "youtube",
            username: "viewer",
            userId: "UCviewer", // RAW platform id — WS invariant #1
            userDisplayName: "Viewer",
            profilePicUrl: "https://example.com/avatar.png",
            rawText: "hello @Bob!",
            whisper: false,
            action: false,
            isBroadcaster: false,
            isMod: false,
            isSubscriber: false,
            isSharedChatMessage: false
        });
    });

    it("splits text into text + mention parts for @tokens", () => {
        const msg = ingestMessageToFirebotChatMessage(baseIngest);
        expect(msg?.parts).toEqual([
            { type: "text", text: "hello" },
            { type: "mention", text: "@Bob!", username: "Bob", userId: "", userDisplayName: "Bob" }
        ]);
    });

    it("derives roles and badges from author flags", () => {
        const msg = ingestMessageToFirebotChatMessage({
            ...baseIngest,
            author: { ...baseIngest.author, isOwner: true, isModerator: true, isSponsor: true }
        });
        expect(msg?.roles).toEqual(["broadcaster", "mod", "sub"]);
        expect(msg?.badges).toEqual([
            { title: "broadcaster", url: "" },
            { title: "mod", url: "" },
            { title: "subscriber", url: "" }
        ]);
        expect(msg?.isBroadcaster).toBe(true);
        expect(msg?.isMod).toBe(true);
        expect(msg?.isSubscriber).toBe(true);
    });

    it("tags the message when it directly mentions the streamer's display name", () => {
        const msg = ingestMessageToFirebotChatMessage(
            { ...baseIngest, text: "hey @Firebot!" },
            { selfDisplayName: "Firebot" }
        );
        expect(msg?.tagged).toBe(true);
    });

    it("does not tag when the streamer's display name is not mentioned", () => {
        const msg = ingestMessageToFirebotChatMessage(baseIngest, { selfDisplayName: "Firebot" });
        expect(msg?.tagged).toBe(false);
    });
});

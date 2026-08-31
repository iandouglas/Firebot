/**
 * WS-7: YouTube replace variables.
 *
 * Each evaluator reads its value from the event trigger's `metadata.eventData`
 * (exactly what the WS-7 event mapping ships) and falls back to null-when-not-
 * in-YouTube-context ("" for the message variable, 0 for the gift count — the
 * twitch conventions). No collaborator is mocked; the variables are pure.
 */

import type { ReplaceVariable, Trigger } from "../../../../../types/variables";

// The variables aggregation index statically imports ReplaceVariableManager,
// whose own import graph is unbootable under jest — stub it (registration is
// exercised in the events smoke suite instead).
jest.mock("../../../../variables/replace-variable-manager", () => ({
    ReplaceVariableManager: {
        registerReplaceVariable: jest.fn(),
        unregisterReplaceVariable: jest.fn()
    }
}));

import youtubeViewerCount from "../variables/youtube-viewer-count";
import superChatAmount from "../variables/super-chat-amount";
import superChatCurrency from "../variables/super-chat-currency";
import superChatTier from "../variables/super-chat-tier";
import superChatMessage from "../variables/super-chat-message";
import memberLevelName from "../variables/member-level-name";
import memberMonth from "../variables/member-month";
import memberIsUpgrade from "../variables/member-is-upgrade";
import giftedMembershipCount from "../variables/gifted-membership-count";
import { variableHandles, youTubeVariables } from "../variables/index";

function makeTrigger(eventData: Record<string, unknown>): Trigger {
    return {
        type: "event",
        metadata: {
            username: "MemberMcGee",
            eventData: eventData
        }
    } as unknown as Trigger;
}

function evaluate(model: ReplaceVariable, eventData: Record<string, unknown>): unknown {
    return (model as { evaluator: (trigger: Trigger) => unknown }).evaluator(makeTrigger(eventData));
}

describe("variable evaluators", () => {
    const cases: Array<{ name: string; model: ReplaceVariable; eventData: Record<string, unknown>; expected: unknown }> = [
        {
            name: "$youtubeViewerCount reads viewerCount from the stream-online payload",
            model: youtubeViewerCount,
            eventData: { username: "Channel", viewerCount: 128 },
            expected: 128
        },
        {
            name: "$superChatAmount reads the formatted display string",
            model: superChatAmount,
            eventData: { username: "Sally", superChatAmountDisplay: "$5.00" },
            expected: "$5.00"
        },
        {
            name: "$superChatCurrency reads the currency code",
            model: superChatCurrency,
            eventData: { superChatCurrency: "EUR" },
            expected: "EUR"
        },
        {
            name: "$superChatTier reads the tier number",
            model: superChatTier,
            eventData: { superChatTier: 3 },
            expected: 3
        },
        {
            name: "$superChatMessage reads the purchase comment",
            model: superChatMessage,
            eventData: { superChatMessage: "Love the stream!" },
            expected: "Love the stream!"
        },
        {
            name: "$memberLevelName reads the level name",
            model: memberLevelName,
            eventData: { memberLevelName: "Legend" },
            expected: "Legend"
        },
        {
            name: "$memberMonth reads the milestone month from a number",
            model: memberMonth,
            eventData: { memberMonth: 12 },
            expected: 12
        },
        {
            name: "$memberMonth coerces the raw API string form",
            model: memberMonth,
            eventData: { memberMonth: "6" },
            expected: 6
        },
        {
            name: "$memberIsUpgrade reads the upgrade boolean (false)",
            model: memberIsUpgrade,
            eventData: { memberIsUpgrade: false },
            expected: false
        },
        {
            name: "$memberIsUpgrade reads the upgrade boolean (true)",
            model: memberIsUpgrade,
            eventData: { memberIsUpgrade: true },
            expected: true
        },
        {
            name: "$giftedMembershipCount reads the gift count",
            model: giftedMembershipCount,
            eventData: { username: "GiftGuru", giftCount: 5 },
            expected: 5
        }
    ];

    for (const variableCase of cases) {
        it(variableCase.name, () => {
            expect(evaluate(variableCase.model, variableCase.eventData)).toBe(variableCase.expected);
        });
    }

    it("$youtubeViewerCount parses WS-2's raw concurrentViewers string form", () => {
        expect(evaluate(youtubeViewerCount, { concurrentViewers: "42" })).toBe(42);
    });
});

describe("null-safety outside a YouTube context", () => {
    it("returns null for every nullable value plus the twitch-convention fallbacks when no event data exists", () => {
        const emptyTriggerEventData = {};

        expect(evaluate(youtubeViewerCount, emptyTriggerEventData)).toBeNull();
        expect(evaluate(superChatAmount, emptyTriggerEventData)).toBeNull();
        expect(evaluate(superChatCurrency, emptyTriggerEventData)).toBeNull();
        expect(evaluate(superChatTier, emptyTriggerEventData)).toBeNull();
        expect(evaluate(memberLevelName, emptyTriggerEventData)).toBeNull();
        expect(evaluate(memberMonth, emptyTriggerEventData)).toBeNull();
        expect(evaluate(memberIsUpgrade, emptyTriggerEventData)).toBeNull();
        expect(evaluate(giftedMembershipCount, emptyTriggerEventData)).toBe(0);
        expect(evaluate(superChatMessage, emptyTriggerEventData)).toBe("");
    });

    it("never throws with null-ish and junk values", () => {
        expect(evaluate(youtubeViewerCount, { viewerCount: "not-a-number" })).toBeNull();
        expect(evaluate(memberMonth, { memberMonth: "soon" })).toBeNull();
        expect(evaluate(superChatTier, { superChatTier: null })).toBeNull();
        expect(evaluate(superChatAmount, { superChatAmountDisplay: null })).toBeNull();
        expect(evaluate(memberIsUpgrade, { memberIsUpgrade: "yes" })).toBeNull();
    });

    it("$youtubeViewerCount tolerates a missing eventData block entirely", () => {
        const trigger = { type: "event", metadata: { username: "x" } } as unknown as Trigger;
        expect((youtubeViewerCount as { evaluator: (trigger: Trigger) => unknown }).evaluator(trigger)).toBeNull();
    });
});

describe("variable definitions", () => {
    it("aggregates exactly the nine documented handles", () => {
        expect(variableHandles).toEqual([
            "youtubeViewerCount",
            "superChatAmount",
            "superChatCurrency",
            "superChatTier",
            "superChatMessage",
            "memberLevelName",
            "memberMonth",
            "memberIsUpgrade",
            "giftedMembershipCount"
        ]);
        expect(variableHandles.length).toBe(youTubeVariables.length);
    });

    it("every variable has a description, category set and manual trigger so it surfaces in the variable UI", () => {
        for (const definition of youTubeVariables) {
            expect(definition.definition.description.length).toBeGreaterThan(0);
            expect((definition.definition.categories ?? []).length).toBeGreaterThan(0);
            expect((definition.definition.triggers as Record<string, unknown>).manual).toBe(true);
            expect(definition.definition.possibleDataOutput.length).toBeGreaterThan(0);
        }
    });

    it("event triggers point at youtube: event ids only (D8 — no twitch:* reuse)", () => {
        for (const definition of youTubeVariables) {
            const eventTriggers = (definition.definition.triggers as Record<string, unknown>).event as string[];
            expect(eventTriggers).toBeDefined();
            for (const trigger of eventTriggers) {
                expect(trigger.startsWith("youtube:")).toBe(true);
            }
        }
    });
});
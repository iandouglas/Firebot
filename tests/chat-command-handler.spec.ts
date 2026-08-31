/**
 * WS-5: command failure messages route through platform-dispatch (both
 * platforms) while the Twitch behavior (bot voice + send-as-reply) is preserved.
 */

jest.mock("../src/backend/logger-cache", () => ({
    LoggerCache: {
        getLogger: () => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        })
    }
}));

jest.mock("../src/backend/common/account-access", () => ({
    AccountAccess: {
        getAccounts: jest.fn()
    }
}));

jest.mock("../src/backend/common/frontend-communicator", () => ({
    __esModule: true,
    default: {
        on: jest.fn(),
        onAsync: jest.fn(),
        send: jest.fn()
    }
}));

jest.mock("../src/backend/chat/commands/command-manager", () => ({
    CommandManager: {
        getAllActiveCommands: jest.fn(),
        saveCustomCommand: jest.fn()
    }
}));

jest.mock("../src/backend/restrictions/restriction-manager", () => ({
    RestrictionsManager: {
        runRestrictionPredicates: jest.fn()
    }
}));

jest.mock("../src/backend/common/settings-manager", () => ({
    SettingsManager: {
        getSetting: jest.fn()
    }
}));

jest.mock("../src/backend/chat/platform-dispatch", () => ({
    platformDispatch: {
        sendChatMessage: jest.fn()
    }
}));

jest.mock("../src/backend/streaming-platforms/twitch/api", () => ({
    TwitchApi: {
        chat: {
            sendChatMessage: jest.fn(),
            deleteChatMessage: jest.fn()
        }
    }
}));

jest.mock("../src/backend/chat/commands/command-cooldown-manager", () => ({
    __esModule: true,
    default: {
        getRemainingCooldown: jest.fn(),
        cooldownCommand: jest.fn()
    }
}));

jest.mock("../src/backend/chat/commands/command-runner", () => ({
    __esModule: true,
    default: {
        buildUserCommand: jest.fn(),
        fireCommand: jest.fn()
    }
}));

jest.mock("../src/backend/utils", () => ({
    escapeRegExp: (value: string) => value,
    humanizeTime: (millis: number) => `${millis}ms`
}));

import { AccountAccess } from "../src/backend/common/account-access";
import { platformDispatch } from "../src/backend/chat/platform-dispatch";
import commandHandler from "../src/backend/chat/commands/chat-command-handler";
import { CommandManager } from "../src/backend/chat/commands/command-manager";
import commandCooldownManager from "../src/backend/chat/commands/command-cooldown-manager";
import commandRunner from "../src/backend/chat/commands/command-runner";
import { RestrictionsManager } from "../src/backend/restrictions/restriction-manager";
import { TwitchApi } from "../src/backend/streaming-platforms/twitch/api";
import type { CommandDefinition, FirebotChatMessage, UserCommand } from "../src/types";

const mockGetAllActiveCommands = (CommandManager.getAllActiveCommands as unknown) as jest.Mock;
const mockRunRestrictionPredicates = (RestrictionsManager.runRestrictionPredicates as unknown) as jest.Mock;
const mockGetRemainingCooldown = (commandCooldownManager.getRemainingCooldown as unknown) as jest.Mock;
const mockCooldownCommand = (commandCooldownManager.cooldownCommand as unknown) as jest.Mock;
const mockBuildUserCommand = (commandRunner.buildUserCommand as unknown) as jest.Mock;
const mockFireCommand = (commandRunner.fireCommand as unknown) as jest.Mock;
const mockSendDispatch = (platformDispatch.sendChatMessage as unknown) as jest.Mock;
const mockTwitchSendChatMessage = (TwitchApi.chat.sendChatMessage as unknown) as jest.Mock;
const mockGetAccounts = (AccountAccess.getAccounts as unknown) as jest.Mock;

function makeCommand(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
    return {
        type: "custom",
        id: "cmd-1",
        trigger: "!restricted",
        active: true,
        count: 0,
        scanWholeMessage: false,
        restrictionData: {
            restrictions: [],
            sendFailMessage: true,
            useCustomFailMessage: false,
            sendAsReply: false
        },
        ...overrides
    } as never;
}

let messageIdCounter = 0;

function makeChatMessage(overrides: Partial<FirebotChatMessage> = {}): FirebotChatMessage {
    messageIdCounter += 1;
    return {
        id: `chat-msg-${messageIdCounter}`,
        username: "vieweruser",
        userId: "viewer-user-id",
        roles: [],
        badges: [],
        rawText: "!restricted",
        parts: [],
        whisper: false,
        action: false,
        tagged: false,
        platform: "twitch",
        ...overrides
    } as FirebotChatMessage;
}

function makeUserCommand(overrides: Partial<UserCommand> = {}): UserCommand {
    return {
        commandSender: "vieweruser",
        cmd: { trigger: "!restricted" } as never,
        userCommand: "userCmd" as never,
        args: [],
        triggeredArg: null as never,
        triggeredSubcmd: null as never,
        isInvalidSubcommandTrigger: false,
        trigger: "!restricted",
        ...overrides
    } as unknown as UserCommand;
}

beforeEach(() => {
    mockGetAccounts.mockReturnValue({
        streamer: { username: "streameruser" },
        bot: { username: "botuser" }
    });
    mockGetAllActiveCommands.mockReturnValue([makeCommand()]);
    mockGetRemainingCooldown.mockReturnValue(0);
    mockRunRestrictionPredicates.mockResolvedValue({ success: true });
    mockBuildUserCommand.mockImplementation((command: CommandDefinition) => makeUserCommand());
});

describe("chat command handler failure messages", () => {
    it("sends restriction-failure messages through the dispatch layer to both platforms", async () => {
        const command = makeCommand({
            restrictionData: {
                restrictions: [],
                sendFailMessage: true,
                useCustomFailMessage: false,
                sendAsReply: false
            } as never
        });
        mockGetAllActiveCommands.mockReturnValue([command]);
        mockRunRestrictionPredicates.mockResolvedValue({ success: false, failureReason: "not allowed" });

        const result = await commandHandler.handleChatMessage(makeChatMessage());

        expect(result.ranCommand).toBe(false);
        expect(mockSendDispatch).toHaveBeenCalledTimes(1);
        expect(mockSendDispatch).toHaveBeenCalledWith(
            expect.stringContaining("you cannot use this command because: not allowed"),
            {
                destination: "both",
                accountType: "Bot",
                replyToMessageId: null
            }
        );
        // The Twitch transport is no longer called directly for failure messages —
        // dispatch owns the fan-out.
        expect(mockTwitchSendChatMessage).not.toHaveBeenCalled();
    });

    it("preserves send-as-reply on Twitch for restriction failures", async () => {
        const command = makeCommand({
            restrictionData: {
                restrictions: [],
                sendFailMessage: true,
                useCustomFailMessage: false,
                sendAsReply: true
            } as never
        });
        mockGetAllActiveCommands.mockReturnValue([command]);
        mockRunRestrictionPredicates.mockResolvedValue({ success: false, failureReason: "not enough points" });

        const chatMessage = makeChatMessage();
        await commandHandler.handleChatMessage(chatMessage);

        expect(mockSendDispatch).toHaveBeenCalledWith(
            expect.stringContaining("not enough points"),
            expect.objectContaining({
                destination: "both",
                replyToMessageId: chatMessage.id
            })
        );
    });

    it("applies custom fail messages and {user} replacement", async () => {
        const command = makeCommand({
            restrictionData: {
                restrictions: [],
                sendFailMessage: true,
                useCustomFailMessage: true,
                failMessage: "{user} is banned from this command",
                sendAsReply: false
            } as never
        });
        mockGetAllActiveCommands.mockReturnValue([command]);
        mockRunRestrictionPredicates.mockResolvedValue({ success: false, failureReason: "whatever" });

        await commandHandler.handleChatMessage(makeChatMessage());

        expect(mockSendDispatch).toHaveBeenCalledWith(
            "vieweruser is banned from this command",
            expect.objectContaining({ destination: "both" })
        );
    });

    it("routes invalid-subcommand messages through the dispatch layer to both platforms", async () => {
        const command = makeCommand();
        mockGetAllActiveCommands.mockReturnValue([command]);
        mockBuildUserCommand.mockReturnValue(makeUserCommand({ isInvalidSubcommandTrigger: true }));

        await commandHandler.handleChatMessage(makeChatMessage({ rawText: "!restricted bogus" }));

        expect(mockSendDispatch).toHaveBeenCalledTimes(1);
        expect(mockSendDispatch).toHaveBeenCalledWith("Invalid Command: unknown arg used.", {
            destination: "both",
            accountType: "Bot"
        });
        expect(mockTwitchSendChatMessage).not.toHaveBeenCalled();
    });

    it("does not dispatch failure messages when the command passes restrictions and runs", async () => {
        const command = makeCommand();
        mockGetAllActiveCommands.mockReturnValue([command]);
        mockRunRestrictionPredicates.mockResolvedValue({ success: true });

        const result = await commandHandler.handleChatMessage(makeChatMessage());

        expect(result.ranCommand).toBe(true);
        expect(mockFireCommand).toHaveBeenCalled();
        expect(mockSendDispatch).not.toHaveBeenCalled();
        expect(mockCooldownCommand).toHaveBeenCalled();
    });

    it("does not dispatch failure messages when restriction messaging is disabled", async () => {
        const command = makeCommand({
            restrictionData: {
                restrictions: [],
                sendFailMessage: false
            } as never
        });
        mockGetAllActiveCommands.mockReturnValue([command]);
        mockRunRestrictionPredicates.mockResolvedValue({ success: false, failureReason: "reason" });

        await commandHandler.handleChatMessage(makeChatMessage());

        expect(mockSendDispatch).not.toHaveBeenCalled();
        expect(mockTwitchSendChatMessage).not.toHaveBeenCalled();
    });
});
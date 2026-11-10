import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import * as subject from "../src/index.js";

type Operator = {
  getStatus: (vmId: string) => Promise<unknown>;
  start: (vmId: string) => Promise<unknown>;
  runPowerShell: (vmId: string, script: string) => Promise<unknown>;
  takeScreenshot: (vmId: string) => Promise<unknown>;
  sendInput: (vmId: string, input: unknown) => Promise<unknown>;
  listWindows: (vmId: string) => Promise<unknown>;
  focusWindow: (vmId: string, handle: number) => Promise<unknown>;
  uiSnapshot: (vmId: string, scope?: unknown) => Promise<unknown>;
  uiFind: (vmId: string, locator: SemanticLocator, scope?: unknown) => Promise<unknown>;
  uiInteract: (
    vmId: string,
    commands: SemanticCommand[],
  ) => Promise<unknown>;
  restore: (vmId: string) => Promise<unknown>;
};

type SemanticLocator = {
  automationId?: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  ancestor?: SemanticLocator;
  descendant?: SemanticLocator;
  sibling?: SemanticLocator;
  fuzzy?: boolean;
  index?: number;
};

type SemanticAction =
  | { type: "invoke" | "focus" | "toggle" | "expand" }
  | { type: "value" | "select"; value: string };

type SemanticCommand =
  | { type: "snapshot" }
  | { type: "find"; locator: SemanticLocator }
  | { type: "interact"; ref: string; action: SemanticAction };

type ConnectableServer = {
  connect: (transport: InMemoryTransport) => Promise<void>;
  close: () => Promise<void>;
};

function requiredExport<T>(name: string): T {
  const value = (subject as Record<string, unknown>)[name];

  if (typeof value !== "function") {
    throw new Error(`Expected src/index.ts to export function ${name}`);
  }

  return value as T;
}

function expectInvalidRequest(result: unknown): void {
  expect(result).toMatchObject({
    isError: true,
    structuredContent: {
      error: { code: "INVALID_REQUEST", message: expect.stringMatching(/\S/) },
    },
  });
}

describe("MCP server contract", () => {
  it("exposes only the supported operations and returns structured tool errors", async () => {
    const createServer = requiredExport<
      (operator: Operator) => ConnectableServer
    >("createServer");
    const operator: Operator = {
      getStatus: vi.fn().mockRejectedValue(new Error("prlctl unavailable")),
      start: vi.fn(),
      runPowerShell: vi.fn(),
      takeScreenshot: vi.fn(),
      sendInput: vi.fn(),
      listWindows: vi.fn(),
      focusWindow: vi.fn(),
      restore: vi.fn(),
      uiSnapshot: vi.fn(),
      uiFind: vi.fn(),
      uiInteract: vi.fn(),
    };
    const server = createServer(operator);
    const client = new Client({ name: "contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();

      // A2-1: run_prototype_flow is retired; general input/window tools are exposed.
      // C4-1: vm_restore joins the surface (11 tools).
      expect(tools.map(({ name }) => name).sort()).toEqual([
        "focus_window",
        "list_windows",
        "run_powershell",
        "send_input",
        "take_screenshot",
        "ui_find",
        "ui_interact",
        "ui_snapshot",
        "vm_restore",
        "vm_start",
        "vm_status",
      ]);

      const result = await client.callTool({
        name: "vm_status",
        arguments: { vmId: "2f1db728-4d9d-4bb7-8c0d-787ea901bd42" },
      });

      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.any(String) }],
        structuredContent: {
          error: {
            code: expect.any(String),
            message: expect.any(String),
          },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("routes semantic requests and rejects malformed locators and actions", async () => {
    const createServer = requiredExport<
      (operator: Operator) => ConnectableServer
    >("createServer");
    const locator: SemanticLocator = {
      role: "Button",
      descendant: { text: "Stop" },
      ancestor: { text: "Example Device" },
    };
    const commands: SemanticCommand[] = [
      { type: "find", locator },
      { type: "interact", ref: "$last", action: { type: "invoke" } },
    ];
    const operator: Operator = {
      getStatus: vi.fn(),
      start: vi.fn(),
      runPowerShell: vi.fn(),
      takeScreenshot: vi.fn(),
      sendInput: vi.fn(),
      listWindows: vi.fn(),
      focusWindow: vi.fn(),
      restore: vi.fn(),
      uiSnapshot: vi.fn(),
      uiFind: vi.fn().mockResolvedValue({ ref: "semantic-ref-1" }),
      uiInteract: vi.fn().mockRejectedValue(new Error("stale ref")),
    };
    const server = createServer(operator);
    const client = new Client({ name: "semantic-contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      await client.callTool({
        name: "ui_find",
        arguments: {
          vmId: "2f1db728-4d9d-4bb7-8c0d-787ea901bd42",
          locator,
        },
      });

      expect(operator.uiFind).toHaveBeenCalledWith(
        "2f1db728-4d9d-4bb7-8c0d-787ea901bd42",
        locator,
      );

      // NS1: invalid input is an INVALID_REQUEST tool error result, not a JSON-RPC error.
      expectInvalidRequest(
        await client.callTool({
          name: "ui_find",
          arguments: {
            vmId: "2f1db728-4d9d-4bb7-8c0d-787ea901bd42",
            locator: {},
          },
        }),
      );
      expect(operator.uiFind).toHaveBeenCalledTimes(1);
      expectInvalidRequest(
        await client.callTool({
          name: "ui_interact",
          arguments: {
            vmId: "2f1db728-4d9d-4bb7-8c0d-787ea901bd42",
            commands: [
              { type: "find", locator },
              {
                type: "interact",
                ref: "$last",
                action: { type: "click" },
              },
            ],
          },
        }),
      );
      expect(operator.uiInteract).not.toHaveBeenCalled();

      const result = await client.callTool({
        name: "ui_interact",
        arguments: {
          vmId: "2f1db728-4d9d-4bb7-8c0d-787ea901bd42",
          commands,
        },
      });

      expect(operator.uiInteract).toHaveBeenCalledWith(
        "2f1db728-4d9d-4bb7-8c0d-787ea901bd42",
        commands,
      );

      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: expect.any(String),
            message: expect.any(String),
          },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("R-6 server identity", () => {
  it("reports the package.json version in the initialize serverInfo", async () => {
    const packageVersion = (
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
    ).version;
    const createServer = requiredExport<(operator: Operator) => ConnectableServer>("createServer");
    const operator: Operator = {
      getStatus: vi.fn(),
      start: vi.fn(),
      runPowerShell: vi.fn(),
      takeScreenshot: vi.fn(),
      sendInput: vi.fn(),
      listWindows: vi.fn(),
      focusWindow: vi.fn(),
      restore: vi.fn(),
      uiSnapshot: vi.fn(),
      uiFind: vi.fn(),
      uiInteract: vi.fn(),
    };
    const server = createServer(operator);
    const client = new Client({ name: "version-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      expect(client.getServerVersion()?.version).toBe(packageVersion);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// UI1–UI9 ui_interact advertises its command shapes and explains invalid commands.
// The advertised schema must stay permissive: bad input still reaches our INVALID_REQUEST path.
// Messages are matched by substring only, never by exact zod wording.

const UI_VM_ID = "2f1db728-4d9d-4bb7-8c0d-787ea901bd42";
const COMMAND_TYPES = ["snapshot", "find", "interact", "assert", "wait"];
const ACTION_TYPES = ["invoke", "focus", "toggle", "expand", "collapse", "value", "select"];

async function withUiInteractServer(
  run: (client: Client, uiInteract: ReturnType<typeof vi.fn>) => Promise<void>,
): Promise<void> {
  const createServer = requiredExport<(operator: Operator) => ConnectableServer>("createServer");
  const uiInteract = vi.fn().mockResolvedValue({ results: [] });
  const operator: Operator = {
    getStatus: vi.fn(),
    start: vi.fn(),
    runPowerShell: vi.fn(),
    takeScreenshot: vi.fn(),
    sendInput: vi.fn(),
    listWindows: vi.fn(),
    focusWindow: vi.fn(),
    restore: vi.fn(),
    uiSnapshot: vi.fn(),
    uiFind: vi.fn(),
    uiInteract,
  };
  const server = createServer(operator);
  const client = new Client({ name: "ui-interact-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client, uiInteract);
  } finally {
    await client.close();
    await server.close();
  }
}

function callUiInteract(client: Client, args: Record<string, unknown>) {
  return client.callTool({ name: "ui_interact", arguments: { vmId: UI_VM_ID, ...args } });
}

/** Asserts INVALID_REQUEST and returns its message. */
function invalidRequestMessage(result: unknown): string {
  expectInvalidRequest(result);
  return (result as { structuredContent: { error: { message: string } } }).structuredContent.error.message;
}

function expectWords(text: string, words: readonly string[]): void {
  for (const word of words) expect(text, `missing "${word}" in: ${text}`).toMatch(new RegExp(`\\b${word}\\b`));
}

async function advertisedCommands(client: Client): Promise<Record<string, unknown>> {
  const { tools } = await client.listTools();
  const tool = tools.find(({ name }) => name === "ui_interact");
  const properties = tool?.inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
  return properties?.commands ?? {};
}

const uiLocator = { role: "Button", name: "Stop" };
const uiAssertion = { property: "Name", equals: "Stop" };

describe("UI ui_interact command schema and errors", () => {
  it("UI1 tools/list describes commands as an array of commands or names every command type", async () => {
    await withUiInteractServer(async (client) => {
      const commands = await advertisedCommands(client);

      expect(commands).not.toEqual({});
      const isArrayWithItems = commands.type === "array" && commands.items !== undefined;
      const description = typeof commands.description === "string" ? commands.description : "";
      const describesEveryType = COMMAND_TYPES.every((type) => new RegExp(`\\b${type}\\b`).test(description));
      expect(
        isArrayWithItems || describesEveryType,
        `commands is neither an array with items nor described: ${JSON.stringify(commands)}`,
      ).toBe(true);
    });
  });

  it("UI2 the advertised commands schema covers every command type, action and both assert forms", async () => {
    await withUiInteractServer(async (client) => {
      const text = JSON.stringify(await advertisedCommands(client));

      expectWords(text, COMMAND_TYPES);
      expectWords(text, ACTION_TYPES);
      expectWords(text, ["ref", "locator", "assertion"]);
    });
  });

  it.each([
    ["a string", "x"],
    ["a number item", [42]],
    ["an empty object item", [{}]],
  ])("UI3 commands that are %s still return INVALID_REQUEST, not a protocol error", async (_label, commands) => {
    await withUiInteractServer(async (client, uiInteract) => {
      expectInvalidRequest(await callUiInteract(client, { commands }));
      expect(uiInteract).not.toHaveBeenCalled();
    });
  });

  it("UI4 an unknown command type lists the valid types", async () => {
    await withUiInteractServer(async (client, uiInteract) => {
      const message = invalidRequestMessage(await callUiInteract(client, { commands: [{ type: "click" }] }));

      expect(message).toContain("commands[0]");
      expectWords(message, COMMAND_TYPES);
      expect(uiInteract).not.toHaveBeenCalled();
    });
  });

  it("UI5 a command without a type lists the valid types", async () => {
    await withUiInteractServer(async (client, uiInteract) => {
      const message = invalidRequestMessage(await callUiInteract(client, { commands: [{ ref: "r1" }] }));

      expect(message).toContain("commands[0]");
      expectWords(message, COMMAND_TYPES);
      expect(uiInteract).not.toHaveBeenCalled();
    });
  });

  it("UI6 an invalid interact action names the action field and lists the valid actions", async () => {
    await withUiInteractServer(async (client, uiInteract) => {
      const message = invalidRequestMessage(
        await callUiInteract(client, {
          commands: [
            { type: "find", locator: uiLocator },
            { type: "interact", ref: "$last", action: { type: "click" } },
          ],
        }),
      );

      expect(message).toContain("commands[1].action");
      expectWords(message, ACTION_TYPES);
      expect(uiInteract).not.toHaveBeenCalled();
    });
  });

  it("UI6 a find without a locator names the locator field", async () => {
    await withUiInteractServer(async (client, uiInteract) => {
      const message = invalidRequestMessage(await callUiInteract(client, { commands: [{ type: "find" }] }));

      expect(message).toContain("commands[0]");
      expectWords(message, ["locator"]);
      expect(uiInteract).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["by ref", { type: "assert", ref: "$last", assertion: uiAssertion }],
    ["by locator", { type: "assert", locator: uiLocator, assertion: uiAssertion, scope: { windowName: "App" } }],
  ])("UI7 an assert %s is routed to the operator unchanged", async (_label, command) => {
    await withUiInteractServer(async (client, uiInteract) => {
      await callUiInteract(client, { commands: [command] });

      expect(uiInteract).toHaveBeenCalledWith(UI_VM_ID, [command]);
    });
  });

  it("UI7 an assert with neither ref nor locator names both fields", async () => {
    await withUiInteractServer(async (client, uiInteract) => {
      const message = invalidRequestMessage(
        await callUiInteract(client, { commands: [{ type: "assert", assertion: uiAssertion }] }),
      );

      expect(message).toContain("commands[0]");
      expectWords(message, ["ref", "locator"]);
      expect(uiInteract).not.toHaveBeenCalled();
    });
  });

  it("UI8 a valid batch of every command type reaches the operator unchanged", async () => {
    await withUiInteractServer(async (client, uiInteract) => {
      const commands = [
        { type: "snapshot", scope: { windowName: "App", maxDepth: 4 } },
        { type: "find", locator: uiLocator },
        { type: "interact", ref: "$last", action: { type: "invoke" } },
        { type: "interact", ref: "$last", action: { type: "value", value: "42" } },
        { type: "assert", ref: "$last", assertion: uiAssertion },
        { type: "wait", locator: uiLocator, assertion: { property: "IsEnabled", equals: "True" }, timeoutMs: 5_000 },
      ];

      const result = await callUiInteract(client, { commands });

      expect(uiInteract).toHaveBeenCalledWith(UI_VM_ID, commands);
      expect(result).not.toMatchObject({ isError: true });
    });
  });

  it("UI10 an invalid nested locator field is reported at its full path", async () => {
    await withUiInteractServer(async (client, uiInteract) => {
      // locatorTextSchema trims and requires at least one character, so an empty ancestor name fails.
      const message = invalidRequestMessage(
        await callUiInteract(client, { commands: [{ type: "find", locator: { ancestor: { name: "" } } }] }),
      );

      expect(message).toContain("commands[0].locator.ancestor.name");
      expect(uiInteract).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["no commands", { commands: [] }],
    ["51 commands", { commands: Array.from({ length: 51 }, () => ({ type: "snapshot" })) }],
    ["an unknown key on a command", { commands: [{ type: "snapshot", extra: 1 }] }],
  ])("UI9 %s is still rejected with INVALID_REQUEST", async (_label, args) => {
    await withUiInteractServer(async (client, uiInteract) => {
      expectInvalidRequest(await callUiInteract(client, args));
      expect(uiInteract).not.toHaveBeenCalled();
    });
  });
});

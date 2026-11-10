import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as subject from "../src/index.js";
import {
  AgentFailure,
  createFakeGuestAgent,
  type AgentCommand,
} from "./helpers/fake-guest-agent.js";

// C-003: the host operator drives the guest agent (NDJSON) instead of WinRemote.
//
// Assumed seams (see report):
//   createEnvironmentOperator(env, deps?: {
//     runCommand?: (executable: string, args: readonly string[], options: { shell?: false; ... })
//       => Promise<{ stdout: string; stderr: string }>;
//     spawnProcess?: SemanticAgentClient spawnProcess signature;
//   })

const VM_ID = "2f1db728-4d9d-4bb7-8c0d-787ea901bd42";
const SNAPSHOT_ID = "889bf928-11ba-45fa-b7a4-64edabef1482";
const AGENT_EXECUTABLE = "C:\\Transversals\\Transversals.GuestAgent.exe";

const BASE_ENV = {
  TRANSVERSALS_VM_ID: VM_ID,
  TRANSVERSALS_SNAPSHOT_ID: SNAPSHOT_ID,
  TRANSVERSALS_UI_AGENT_EXECUTABLE: AGENT_EXECUTABLE,
} satisfies NodeJS.ProcessEnv;

type RunCommand = (
  executable: string,
  args: readonly string[],
  options?: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

type OperatorDeps = {
  runCommand?: RunCommand;
  spawnProcess?: ReturnType<typeof createFakeGuestAgent>["spawnProcess"];
};

type EnvironmentOperator = Record<string, (...args: never[]) => Promise<unknown>> & {
  close: () => Promise<void>;
};

type ToolResult = {
  isError?: boolean;
  content: Array<Record<string, unknown> & { type: string }>;
  structuredContent?: Record<string, unknown>;
};

const createEnvironmentOperator = subject.createEnvironmentOperator as unknown as (
  env: NodeJS.ProcessEnv,
  deps?: OperatorDeps,
) => EnvironmentOperator;

const createServer = subject.createServer as unknown as (
  operator: EnvironmentOperator,
) => { connect: (transport: InMemoryTransport) => Promise<void>; close: () => Promise<void> };

function fakePrlctl(state: "running" | "stopped" = "running") {
  return vi.fn<RunCommand>(async (_executable, args) => {
    if (args[0] === "status") {
      return { stdout: `VM {${VM_ID}} exist ${state}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function connect(env: NodeJS.ProcessEnv, deps: OperatorDeps) {
  const operator = createEnvironmentOperator(env, deps);
  const server = createServer(operator);
  const client = new Client({ name: "c003-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    await operator.close();
  });
  return {
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as ToolResult,
    toolNames: async () => (await client.listTools()).tools.map(({ name }) => name),
    tools: async () => (await client.listTools()).tools,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFind(
  value: unknown,
  predicate: (candidate: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    if (predicate(value)) return value;
    for (const child of Object.values(value)) {
      const found = deepFind(child, predicate);
      if (found) return found;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const found = deepFind(child, predicate);
      if (found) return found;
    }
  }
  return undefined;
}

function execPayloadFromText(result: ToolResult): Record<string, unknown> | undefined {
  for (const item of result.content) {
    if (item.type !== "text" || typeof item.text !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.text);
    } catch {
      continue;
    }
    const found = deepFind(parsed, (candidate) => "exitCode" in candidate && "stdout" in candidate);
    if (found) return found;
  }
  return undefined;
}

function textPayloads(result: ToolResult): unknown[] {
  return result.content.flatMap((item) => {
    if (item.type !== "text" || typeof item.text !== "string") return [];
    try {
      return [JSON.parse(item.text) as unknown];
    } catch {
      return [];
    }
  });
}

function findInText(
  result: ToolResult,
  predicate: (candidate: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  for (const payload of textPayloads(result)) {
    const found = deepFind(payload, predicate);
    if (found) return found;
  }
  return undefined;
}

function errorOf(result: ToolResult): Record<string, unknown> {
  expect(result.isError).toBe(true);
  const error = (result.structuredContent as { error?: Record<string, unknown> } | undefined)?.error;
  expect(error).toBeDefined();
  return error!;
}

describe("H-4 configuration", () => {
  it("constructs without WINREMOTE_EXECUTABLE", () => {
    expect(() =>
      createEnvironmentOperator(
        { ...BASE_ENV },
        { runCommand: fakePrlctl(), spawnProcess: createFakeGuestAgent().spawnProcess },
      ),
    ).not.toThrow();
  });

  // C4-8: TRANSVERSALS_SNAPSHOT_ID is no longer required (vm_restore looks up its owned snapshot).
  it.each([
    "TRANSVERSALS_VM_ID",
    "TRANSVERSALS_UI_AGENT_EXECUTABLE",
  ] as const)("still requires %s with CONFIGURATION_ERROR naming it", (missing) => {
    const env: NodeJS.ProcessEnv = { ...BASE_ENV };
    delete env[missing];

    let thrown: unknown;
    try {
      createEnvironmentOperator(env, { runCommand: fakePrlctl() });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "CONFIGURATION_ERROR",
      message: expect.stringContaining(missing),
    });
  });
});

describe("H-7 injectable prlctl runner", () => {
  it("runs `prlctl status <vmId>` through runCommand without a shell", async () => {
    const runCommand = fakePrlctl("running");
    const { call } = await connect(BASE_ENV, {
      runCommand,
      spawnProcess: createFakeGuestAgent().spawnProcess,
    });

    const result = await call("vm_status", { vmId: VM_ID });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ result: { status: "running" } });
    expect(runCommand).toHaveBeenCalledTimes(1);
    const [executable, args, options] = runCommand.mock.calls[0]!;
    expect(executable).toBe("prlctl");
    expect(args).toEqual(["status", VM_ID]);
    expect(options?.shell ?? false).toBe(false);
  });

  it("runs `prlctl start <vmId>` after status when the VM is stopped", async () => {
    const runCommand = fakePrlctl("stopped");
    const { call } = await connect(BASE_ENV, {
      runCommand,
      spawnProcess: createFakeGuestAgent().spawnProcess,
    });

    const result = await call("vm_start", { vmId: VM_ID });

    expect(result.isError).toBeFalsy();
    expect(runCommand.mock.calls.map(([executable, args]) => [executable, args])).toEqual([
      ["prlctl", ["status", VM_ID]],
      ["prlctl", ["start", VM_ID]],
    ]);
    for (const [, , options] of runCommand.mock.calls) {
      expect(options?.shell ?? false).toBe(false);
    }
  });

  it("maps a runCommand rejection to PRLCTL_FAILED", async () => {
    const runCommand = vi.fn<RunCommand>().mockRejectedValue(new Error("prlctl exploded"));
    const { call } = await connect(BASE_ENV, {
      runCommand,
      spawnProcess: createFakeGuestAgent().spawnProcess,
    });

    const result = await call("vm_status", { vmId: VM_ID });

    expect(errorOf(result)).toMatchObject({ code: "PRLCTL_FAILED" });
  });
});

describe("H-1 run_powershell over the guest agent", () => {
  it("sends exactly one exec {script, timeoutMs: 30000} and returns the exec fields as text", async () => {
    const execResult = {
      exitCode: 0,
      stdout: "hello from guest",
      stderr: "a warning",
      stdoutTruncated: true,
      stderrTruncated: false,
      timedOut: false,
    };
    const agent = createFakeGuestAgent({ handlers: { exec: () => execResult } });
    const runCommand = fakePrlctl();
    const { call } = await connect(BASE_ENV, { runCommand, spawnProcess: agent.spawnProcess });
    const script = "Get-Date\nWrite-Output 'x'";

    const result = await call("run_powershell", { vmId: VM_ID, script });

    expect(result.isError).toBeFalsy();
    const execCommands = agent.commands().filter((command) => command.type === "exec");
    expect(execCommands).toStrictEqual([{ type: "exec", script, timeoutMs: 30_000 }]);
    expect(agent.commands().filter((command) => command.type !== "hello")).toHaveLength(1);
    expect(execPayloadFromText(result)).toMatchObject(execResult);

    // H-7: the agent relay is spawned through the injected seam, never a shell.
    expect(agent.spawnCalls.length).toBeGreaterThanOrEqual(1);
    expect(agent.spawnCalls[0]).toMatchObject({
      command: "prlctl",
      args: ["exec", VM_ID, "--current-user", AGENT_EXECUTABLE],
    });
    expect(agent.spawnCalls[0]!.options?.shell ?? false).toBe(false);
  });

  it("keeps the 1..8192 script length validation and never reaches the agent", async () => {
    const agent = createFakeGuestAgent({
      handlers: { exec: () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    });
    const { call } = await connect(BASE_ENV, {
      runCommand: fakePrlctl(),
      spawnProcess: agent.spawnProcess,
    });

    for (const script of ["", "x".repeat(8_193)]) {
      const outcome = await call("run_powershell", { vmId: VM_ID, script }).catch(
        (error: unknown) => ({ thrown: error }),
      );
      expect("thrown" in outcome || (outcome as ToolResult).isError === true).toBe(true);
    }
    expect(agent.commands().filter((command) => command.type === "exec")).toHaveLength(0);
  });
});

describe("H-2 take_screenshot over the guest agent", () => {
  it("sends one screenshot command and returns image/png content with the data unchanged", async () => {
    const data = Buffer.from("not-really-a-png-but-unchanged").toString("base64");
    const agent = createFakeGuestAgent({
      handlers: {
        screenshot: () => ({ mimeType: "image/png", width: 1280, height: 800, data }),
      },
    });
    const { call } = await connect(BASE_ENV, {
      runCommand: fakePrlctl(),
      spawnProcess: agent.spawnProcess,
    });

    const result = await call("take_screenshot", { vmId: VM_ID });

    expect(result.isError).toBeFalsy();
    expect(agent.commands().filter((command) => command.type === "screenshot")).toHaveLength(1);
    expect(agent.commands().filter((command) => command.type !== "hello")).toHaveLength(1);
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "image", mimeType: "image/png", data }),
    );
  });
});

describe("H-5 agent unavailable", () => {
  it.each(["throw-on-spawn", "error-event", "exit-before-response"] as const)(
    "run_powershell returns AGENT_UNAVAILABLE pointing at `transversals doctor` (%s)",
    async (behavior) => {
      const agent = createFakeGuestAgent({ behavior });
      const { call } = await connect(BASE_ENV, {
        runCommand: fakePrlctl(),
        spawnProcess: agent.spawnProcess,
      });

      const result = await call("run_powershell", { vmId: VM_ID, script: "hostname" });

      expect(errorOf(result)).toMatchObject({
        code: "AGENT_UNAVAILABLE",
        message: expect.stringContaining("transversals doctor"),
      });
    },
  );

  it.each([
    ["take_screenshot", {}],
    ["ui_snapshot", {}],
  ] as const)("%s also returns AGENT_UNAVAILABLE when the relay exits early", async (tool, extra) => {
    const agent = createFakeGuestAgent({ behavior: "exit-before-response" });
    const { call } = await connect(BASE_ENV, {
      runCommand: fakePrlctl(),
      spawnProcess: agent.spawnProcess,
    });

    const result = await call(tool, { vmId: VM_ID, ...extra });

    expect(errorOf(result)).toMatchObject({
      code: "AGENT_UNAVAILABLE",
      message: expect.stringContaining("transversals doctor"),
    });
  });

  it("does not classify an agent-reported protocol error as AGENT_UNAVAILABLE", async () => {
    const agent = createFakeGuestAgent({
      handlers: {
        exec: () => {
          throw new AgentFailure("INVALID_REQUEST", "exec: 'script' must be a non-empty string.");
        },
      },
    });
    const { call } = await connect(BASE_ENV, {
      runCommand: fakePrlctl(),
      spawnProcess: agent.spawnProcess,
    });

    const result = await call("run_powershell", { vmId: VM_ID, script: "hostname" });

    expect(errorOf(result)).toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("H-6 agent error mapping", () => {
  it.each(["INVALID_REQUEST", "CAPABILITY_UNAVAILABLE", "BACKEND_FAILURE", "NOT_FOUND"])(
    "run_powershell surfaces agent %s as the same operator error code",
    async (code) => {
      const agent = createFakeGuestAgent({
        handlers: {
          exec: () => {
            throw new AgentFailure(code, `agent said ${code}`);
          },
        },
      });
      const { call } = await connect(BASE_ENV, {
        runCommand: fakePrlctl(),
        spawnProcess: agent.spawnProcess,
      });

      const result = await call("run_powershell", { vmId: VM_ID, script: "hostname" });

      expect(errorOf(result)).toMatchObject({ code, message: expect.stringContaining(code) });
    },
  );

  it("take_screenshot surfaces agent BACKEND_FAILURE", async () => {
    const agent = createFakeGuestAgent({
      handlers: {
        screenshot: () => {
          throw new AgentFailure("BACKEND_FAILURE", "capture failed");
        },
      },
    });
    const { call } = await connect(BASE_ENV, {
      runCommand: fakePrlctl(),
      spawnProcess: agent.spawnProcess,
    });

    const result = await call("take_screenshot", { vmId: VM_ID });

    expect(errorOf(result)).toMatchObject({ code: "BACKEND_FAILURE" });
  });

  it("preserves commandIndex for a failing command inside a ui_interact batch", async () => {
    const agent = createFakeGuestAgent({
      handlers: {
        snapshot: () => ({ id: "root", role: "Pane", capabilities: [], children: [] }),
        find: () => {
          throw new AgentFailure("NOT_FOUND", "no element matched");
        },
      },
    });
    const { call } = await connect(BASE_ENV, {
      runCommand: fakePrlctl(),
      spawnProcess: agent.spawnProcess,
    });

    const result = await call("ui_interact", {
      vmId: VM_ID,
      commands: [{ type: "snapshot" }, { type: "find", locator: { name: "Missing" } }],
    });

    expect(errorOf(result)).toMatchObject({ code: "NOT_FOUND", commandIndex: 1 });
  });
});

// A-002: general input/window pass-through tools over the guest agent.

const OTHER_VM_ID = "00000000-0000-4000-8000-000000000001";

const GUEST_WINDOWS = [
  {
    handle: 2002,
    title: "Calculator",
    processId: 20,
    processName: "CalculatorApp",
    isForeground: true,
  },
  {
    handle: 1001,
    title: "Untitled - Notepad",
    processId: 10,
    processName: "Notepad",
    isForeground: false,
  },
];

function inputWindowAgent(overrides: Parameters<typeof createFakeGuestAgent>[0]["handlers"] = {}) {
  return createFakeGuestAgent({
    handlers: {
      input: () => ({ completed: true }),
      windows: (command) =>
        command.action === "list" ? { windows: GUEST_WINDOWS } : { completed: true },
      ...overrides,
    },
  });
}

function nonHello(agent: ReturnType<typeof createFakeGuestAgent>): AgentCommand[] {
  return agent.commands().filter((command) => command.type !== "hello");
}

/**
 * NS1: host-side validation returns a tool error result (isError, INVALID_REQUEST, a message)
 * rather than a thrown JSON-RPC error, and never reaches the agent.
 */
async function expectHostRejected(
  connection: Awaited<ReturnType<typeof connect>>,
  agent: ReturnType<typeof createFakeGuestAgent>,
  tool: string,
  args: Record<string, unknown>,
): Promise<void> {
  // Guard so a missing tool cannot satisfy the rejection by "Tool not found".
  expect(await connection.toolNames()).toContain(tool);
  const outcome = await connection.call(tool, { vmId: VM_ID, ...args }).then(
    (result) => ({ resolved: result }),
    (error: unknown) => ({ rejected: error }),
  );
  expect(outcome, "invalid input must not throw a JSON-RPC error").toHaveProperty("resolved");
  const error = errorOf((outcome as { resolved: ToolResult }).resolved);
  expect(error.code).toBe("INVALID_REQUEST");
  expect(error.message).toEqual(expect.stringMatching(/\S/));
  expect(nonHello(agent)).toHaveLength(0);
}

describe("A2-2 send_input type", () => {
  it("sends exactly one input/type command and reports completed:true", async () => {
    const agent = inputWindowAgent();
    const { call } = await connect(BASE_ENV, {
      runCommand: fakePrlctl(),
      spawnProcess: agent.spawnProcess,
    });

    const result = await call("send_input", { vmId: VM_ID, action: "type", text: "hello world" });

    expect(result.isError).toBeFalsy();
    expect(nonHello(agent)).toStrictEqual([
      { type: "input", action: "type", text: "hello world" },
    ]);
    expect(findInText(result, (candidate) => candidate.completed === true)).toBeDefined();
  });

  it("accepts the boundary lengths for text (16384) and keys (64)", async () => {
    const agent = inputWindowAgent();
    const { call } = await connect(BASE_ENV, {
      runCommand: fakePrlctl(),
      spawnProcess: agent.spawnProcess,
    });
    const text = "t".repeat(16_384);
    const keys = "k".repeat(64);

    const typed = await call("send_input", { vmId: VM_ID, action: "type", text });
    const pressed = await call("send_input", { vmId: VM_ID, action: "keys", keys });

    expect(typed.isError).toBeFalsy();
    expect(pressed.isError).toBeFalsy();
    expect(nonHello(agent)).toStrictEqual([
      { type: "input", action: "type", text },
      { type: "input", action: "keys", keys },
    ]);
  });

  it.each([
    ["missing action", { text: "a" }],
    ["unknown action", { action: "scroll", text: "a" }],
    ["type without text", { action: "type" }],
    ["type with empty text", { action: "type", text: "" }],
    ["type with text over 16384", { action: "type", text: "x".repeat(16_385) }],
    ["type with non-string text", { action: "type", text: 5 }],
    ["type with a keys field", { action: "type", text: "a", keys: "enter" }],
    ["type with a click field", { action: "type", text: "a", x: 1 }],
    ["type with an unknown key", { action: "type", text: "a", extra: true }],
    ["keys without keys", { action: "keys" }],
    ["keys with empty keys", { action: "keys", keys: "" }],
    ["keys over 64 chars", { action: "keys", keys: "k".repeat(65) }],
    ["keys with a text field", { action: "keys", keys: "enter", text: "a" }],
    ["keys with a click field", { action: "keys", keys: "enter", y: 2 }],
    ["click without y", { action: "click", x: 1 }],
    ["click without x", { action: "click", y: 1 }],
    ["click with non-integer x", { action: "click", x: 1.5, y: 2 }],
    ["click with string y", { action: "click", x: 1, y: "2" }],
    ["click with unsupported button", { action: "click", x: 1, y: 2, button: "middle" }],
    ["click with non-boolean double", { action: "click", x: 1, y: 2, double: "yes" }],
    ["click with a text field", { action: "click", x: 1, y: 2, text: "a" }],
    ["click with a keys field", { action: "click", x: 1, y: 2, keys: "enter" }],
  ] as const)("rejects %s host-side without contacting the agent", async (_label, args) => {
    const agent = inputWindowAgent();
    const connection = await connect(BASE_ENV, {
      runCommand: fakePrlctl(),
      spawnProcess: agent.spawnProcess,
    });

    await expectHostRejected(connection, agent, "send_input", args);
  });
});

describe("A2-3 send_input keys and click", () => {
  it("passes keys through as one input/keys command", async () => {
    const agent = inputWindowAgent();
    const { call } = await connect(BASE_ENV, {
      runCommand: fakePrlctl(),
      spawnProcess: agent.spawnProcess,
    });

    const result = await call("send_input", { vmId: VM_ID, action: "keys", keys: "ctrl+shift+s" });

    expect(result.isError).toBeFalsy();
    expect(nonHello(agent)).toStrictEqual([
      { type: "input", action: "keys", keys: "ctrl+shift+s" },
    ]);
  });

  it.each([
    ["only x and y", { x: 640, y: 400 }],
    ["a right button", { x: 0, y: 12, button: "right" }],
    ["a left double-click", { x: 5, y: 6, button: "left", double: true }],
    ["double without button", { x: 7, y: 8, double: false }],
  ] as const)("passes click with %s through, omitting fields not provided", async (_label, fields) => {
    const agent = inputWindowAgent();
    const { call } = await connect(BASE_ENV, {
      runCommand: fakePrlctl(),
      spawnProcess: agent.spawnProcess,
    });

    const result = await call("send_input", { vmId: VM_ID, action: "click", ...fields });

    expect(result.isError).toBeFalsy();
    expect(nonHello(agent)).toStrictEqual([{ type: "input", action: "click", ...fields }]);
  });
});

describe("A2-4 list_windows", () => {
  it("sends one windows/list command and returns the windows array unchanged", async () => {
    const agent = inputWindowAgent();
    const { call } = await connect(BASE_ENV, {
      runCommand: fakePrlctl(),
      spawnProcess: agent.spawnProcess,
    });

    const result = await call("list_windows", { vmId: VM_ID });

    expect(result.isError).toBeFalsy();
    expect(nonHello(agent)).toStrictEqual([{ type: "windows", action: "list" }]);
    const listed = findInText(result, (candidate) => Array.isArray(candidate.windows));
    expect(listed?.windows).toStrictEqual(GUEST_WINDOWS);
  });
});

describe("A2-5 focus_window", () => {
  it("sends one windows/focus command with the handle", async () => {
    const agent = inputWindowAgent();
    const { call } = await connect(BASE_ENV, {
      runCommand: fakePrlctl(),
      spawnProcess: agent.spawnProcess,
    });

    const result = await call("focus_window", { vmId: VM_ID, handle: 1001 });

    expect(result.isError).toBeFalsy();
    expect(nonHello(agent)).toStrictEqual([{ type: "windows", action: "focus", handle: 1001 }]);
  });

  it.each([
    ["missing", {}],
    ["zero", { handle: 0 }],
    ["negative", { handle: -1 }],
    ["fractional", { handle: 1.5 }],
    ["a string", { handle: "1001" }],
    ["beyond the safe-integer range", { handle: Number.MAX_SAFE_INTEGER + 1 }],
  ] as const)("rejects a %s handle host-side without contacting the agent", async (_label, args) => {
    const agent = inputWindowAgent();
    const connection = await connect(BASE_ENV, {
      runCommand: fakePrlctl(),
      spawnProcess: agent.spawnProcess,
    });

    await expectHostRejected(connection, agent, "focus_window", args);
  });

  it("passes agent NOT_FOUND through as NOT_FOUND", async () => {
    const agent = inputWindowAgent({
      windows: () => {
        throw new AgentFailure("NOT_FOUND", "no window with handle 4040");
      },
    });
    const { call } = await connect(BASE_ENV, {
      runCommand: fakePrlctl(),
      spawnProcess: agent.spawnProcess,
    });

    const result = await call("focus_window", { vmId: VM_ID, handle: 4040 });

    expect(errorOf(result)).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("A2-6 shared vmId and availability handling", () => {
  const TOOL_CALLS = [
    ["send_input", { action: "type", text: "a" }],
    ["list_windows", {}],
    ["focus_window", { handle: 1001 }],
  ] as const;

  it.each(TOOL_CALLS)(
    "%s rejects a vmId that is not the configured VM with INVALID_IDENTIFIER",
    async (tool, extra) => {
      const agent = inputWindowAgent();
      const { call } = await connect(BASE_ENV, {
        runCommand: fakePrlctl(),
        spawnProcess: agent.spawnProcess,
      });

      const result = await call(tool, { vmId: OTHER_VM_ID, ...extra });

      expect(errorOf(result)).toMatchObject({ code: "INVALID_IDENTIFIER" });
      expect(nonHello(agent)).toHaveLength(0);
    },
  );

  it.each(TOOL_CALLS)(
    "%s returns AGENT_UNAVAILABLE pointing at `transversals doctor` when spawn fails",
    async (tool, extra) => {
      const agent = createFakeGuestAgent({ behavior: "throw-on-spawn" });
      const { call } = await connect(BASE_ENV, {
        runCommand: fakePrlctl(),
        spawnProcess: agent.spawnProcess,
      });

      const result = await call(tool, { vmId: VM_ID, ...extra });

      expect(errorOf(result)).toMatchObject({
        code: "AGENT_UNAVAILABLE",
        message: expect.stringContaining("transversals doctor"),
      });
    },
  );
});

// C-004: vm_restore switches to the snapshot transversals owns (`transversals-baseline`).

const OWNED_SNAPSHOT_ID = "7f7cc42d-7e68-4de1-aee8-eea2d9b09038";
const FOREIGN_SNAPSHOT_ID = "c4e8b2a1-7f3d-4a96-b5e0-1d2c3b4a5f60";
const SECOND_OWNED_SNAPSHOT_ID = "3c9d6c1e-5b8a-4f0e-9d2a-6e1f0b7c4a21";

/** Mirrors real `prlctl snapshot-list <vm> -j` output: braced-id keys, tab indentation. */
function snapshotListJson(
  entries: ReadonlyArray<{ id: string; name: string; current?: boolean; parent?: string }>,
): string {
  const body = entries
    .map(
      ({ id, name, current = false, parent = "" }) =>
        `\t"{${id}}": {\n\t\t"name": "${name}",\n\t\t"date": "2026-11-06 13:43:18",\n\t\t"state": "poweron",\n\t\t"current": ${current},\n\t\t"parent": "${parent}"\n\t}`,
    )
    .join(",\n");
  return entries.length === 0 ? "{}\n" : `{\n${body}\n}\n`;
}

const REAL_SNAPSHOT_LIST = snapshotListJson([
  { id: FOREIGN_SNAPSHOT_ID, name: "vm-operator-baseline" },
  {
    id: OWNED_SNAPSHOT_ID,
    name: "transversals-baseline",
    current: true,
    parent: `{${FOREIGN_SNAPSHOT_ID}}`,
  },
]);

const RESTORE_ENV = {
  TRANSVERSALS_VM_ID: VM_ID,
  TRANSVERSALS_UI_AGENT_EXECUTABLE: AGENT_EXECUTABLE,
} satisfies NodeJS.ProcessEnv;

type SnapshotListBehavior = { stdout: string } | { reject: Error };

/** prlctl fake: answers snapshot-list per behavior, status as running, everything else empty. */
function restorePrlctl(snapshotList: SnapshotListBehavior) {
  return vi.fn<RunCommand>(async (_executable, args) => {
    if (args[0] === "snapshot-list") {
      if ("reject" in snapshotList) throw snapshotList.reject;
      return { stdout: snapshotList.stdout, stderr: "" };
    }
    if (args[0] === "status") {
      return { stdout: `VM {${VM_ID}} exist running\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
}

/** A responsive guest agent so any readiness probe after the switch succeeds immediately. */
function readyAgent() {
  return createFakeGuestAgent({
    handlers: {
      exec: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      windows: () => ({ windows: [] }),
      snapshot: () => ({ id: "root", role: "Pane", capabilities: [], children: [] }),
    },
  });
}

function prlctlArgs(runCommand: ReturnType<typeof restorePrlctl>): string[][] {
  return runCommand.mock.calls.map(([, args]) => [...args]);
}

function snapshotSwitchCalls(runCommand: ReturnType<typeof restorePrlctl>): string[][] {
  return prlctlArgs(runCommand).filter((args) => args[0] === "snapshot-switch");
}

describe("C4-2/C4-3 vm_restore owned-snapshot lookup and switch", () => {
  it("looks up snapshots with `prlctl snapshot-list <vmId> -j` without a shell", async () => {
    const runCommand = restorePrlctl({ stdout: REAL_SNAPSHOT_LIST });
    const { call } = await connect(BASE_ENV, {
      runCommand,
      spawnProcess: readyAgent().spawnProcess,
    });

    await call("vm_restore", { vmId: VM_ID, confirm: true });

    const listCall = runCommand.mock.calls.find(([, args]) => args[0] === "snapshot-list");
    expect(listCall).toBeDefined();
    const [executable, args, options] = listCall!;
    expect(executable).toBe("prlctl");
    expect(args).toEqual(["snapshot-list", VM_ID, "-j"]);
    expect(options?.shell ?? false).toBe(false);
  });

  it("switches to the single transversals-baseline snapshot after listing and reports it", async () => {
    const runCommand = restorePrlctl({ stdout: REAL_SNAPSHOT_LIST });
    const { call } = await connect(BASE_ENV, {
      runCommand,
      spawnProcess: readyAgent().spawnProcess,
    });

    const result = await call("vm_restore", { vmId: VM_ID, confirm: true });

    expect(result.isError).toBeFalsy();
    const calls = prlctlArgs(runCommand);
    const listIndex = calls.findIndex((args) => args[0] === "snapshot-list");
    const switchIndex = calls.findIndex((args) => args[0] === "snapshot-switch");
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(switchIndex).toBeGreaterThan(listIndex);
    expect(snapshotSwitchCalls(runCommand)).toEqual([
      ["snapshot-switch", VM_ID, "--id", OWNED_SNAPSHOT_ID],
    ]);
    for (const [executable, , options] of runCommand.mock.calls) {
      expect(executable).toBe("prlctl");
      expect(options?.shell ?? false).toBe(false);
    }
    expect(
      findInText(
        result,
        (candidate) =>
          candidate.snapshotId === OWNED_SNAPSHOT_ID &&
          candidate.name === "transversals-baseline",
      ),
    ).toBeDefined();
  });

  it("never switches to another snapshot or a configured TRANSVERSALS_SNAPSHOT_ID", async () => {
    const runCommand = restorePrlctl({ stdout: REAL_SNAPSHOT_LIST });
    // BASE_ENV still carries a legacy TRANSVERSALS_SNAPSHOT_ID that must be ignored.
    const { call } = await connect(BASE_ENV, {
      runCommand,
      spawnProcess: readyAgent().spawnProcess,
    });

    const result = await call("vm_restore", { vmId: VM_ID, confirm: true });

    expect(result.isError).toBeFalsy();
    expect(snapshotSwitchCalls(runCommand)).toEqual([
      ["snapshot-switch", VM_ID, "--id", OWNED_SNAPSHOT_ID],
    ]);
    const everyArg = prlctlArgs(runCommand).flat().join(" ");
    expect(everyArg).not.toContain(FOREIGN_SNAPSHOT_ID);
    expect(everyArg).not.toContain(SNAPSHOT_ID);
  });
});

describe("C4-4 vm_restore confirm gate", () => {
  it.each([
    ["missing confirm", {}],
    ["confirm:false", { confirm: false }],
    ["a string confirm", { confirm: "true" }],
    ["an unknown key", { confirm: true, snapshotId: OWNED_SNAPSHOT_ID }],
  ] as const)("rejects %s host-side without running prlctl", async (_label, args) => {
    const runCommand = restorePrlctl({ stdout: REAL_SNAPSHOT_LIST });
    const agent = readyAgent();
    const connection = await connect(BASE_ENV, { runCommand, spawnProcess: agent.spawnProcess });

    await expectHostRejected(connection, agent, "vm_restore", args);
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("C4-5 vm_restore without an owned snapshot", () => {
  it.each([
    ["only a foreign snapshot", snapshotListJson([{ id: FOREIGN_SNAPSHOT_ID, name: "vm-operator-baseline" }])],
    ["an empty snapshot object", "{}\n"],
    ["empty output", ""],
  ] as const)("returns SNAPSHOT_NOT_FOUND pointing at `transversals setup` for %s", async (_label, stdout) => {
    const runCommand = restorePrlctl({ stdout });
    const { call } = await connect(BASE_ENV, {
      runCommand,
      spawnProcess: readyAgent().spawnProcess,
    });

    const result = await call("vm_restore", { vmId: VM_ID, confirm: true });

    expect(errorOf(result)).toMatchObject({
      code: "SNAPSHOT_NOT_FOUND",
      message: expect.stringContaining("transversals setup"),
    });
    expect(snapshotSwitchCalls(runCommand)).toHaveLength(0);
  });
});

describe("C4-6 vm_restore with duplicate owned snapshots", () => {
  it("returns SNAPSHOT_AMBIGUOUS and does not switch", async () => {
    const runCommand = restorePrlctl({
      stdout: snapshotListJson([
        { id: FOREIGN_SNAPSHOT_ID, name: "vm-operator-baseline" },
        { id: OWNED_SNAPSHOT_ID, name: "transversals-baseline", current: true },
        { id: SECOND_OWNED_SNAPSHOT_ID, name: "transversals-baseline" },
      ]),
    });
    const { call } = await connect(BASE_ENV, {
      runCommand,
      spawnProcess: readyAgent().spawnProcess,
    });

    const result = await call("vm_restore", { vmId: VM_ID, confirm: true });

    expect(errorOf(result)).toMatchObject({ code: "SNAPSHOT_AMBIGUOUS" });
    expect(snapshotSwitchCalls(runCommand)).toHaveLength(0);
  });
});

describe("C4-7 vm_restore snapshot-list failures", () => {
  it("maps a non-zero snapshot-list exit to PRLCTL_FAILED and does not switch", async () => {
    const runCommand = restorePrlctl({
      reject: Object.assign(new Error("Command failed: prlctl snapshot-list"), { code: 255 }),
    });
    const { call } = await connect(BASE_ENV, {
      runCommand,
      spawnProcess: readyAgent().spawnProcess,
    });

    const result = await call("vm_restore", { vmId: VM_ID, confirm: true });

    expect(errorOf(result)).toMatchObject({ code: "PRLCTL_FAILED" });
    expect(snapshotSwitchCalls(runCommand)).toHaveLength(0);
  });

  it.each([
    ["non-JSON text", "Failed to get snapshot tree\n"],
    ["truncated JSON", `{\n\t"{${OWNED_SNAPSHOT_ID}}": {\n\t\t"name": "transversals-baseline"`],
  ] as const)("fails with a command-failure code for %s and does not switch", async (_label, stdout) => {
    const runCommand = restorePrlctl({ stdout });
    const { call } = await connect(BASE_ENV, {
      runCommand,
      spawnProcess: readyAgent().spawnProcess,
    });

    const result = await call("vm_restore", { vmId: VM_ID, confirm: true });

    expect(["PRLCTL_FAILED", "OPERATION_FAILED"]).toContain(errorOf(result).code);
    expect(snapshotSwitchCalls(runCommand)).toHaveLength(0);
  });
});

describe("C4-8 vm_restore identifiers and configuration", () => {
  it("rejects a vmId that is not the configured VM with INVALID_IDENTIFIER before any prlctl call", async () => {
    const runCommand = restorePrlctl({ stdout: REAL_SNAPSHOT_LIST });
    const { call, toolNames } = await connect(BASE_ENV, {
      runCommand,
      spawnProcess: readyAgent().spawnProcess,
    });
    expect(await toolNames()).toContain("vm_restore");

    const result = await call("vm_restore", { vmId: OTHER_VM_ID, confirm: true });

    expect(errorOf(result)).toMatchObject({ code: "INVALID_IDENTIFIER" });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("constructs the operator and server without TRANSVERSALS_SNAPSHOT_ID", async () => {
    let operator: EnvironmentOperator | undefined;
    expect(() => {
      operator = createEnvironmentOperator(
        { ...RESTORE_ENV },
        { runCommand: restorePrlctl({ stdout: REAL_SNAPSHOT_LIST }), spawnProcess: readyAgent().spawnProcess },
      );
      createServer(operator);
    }).not.toThrow();
    await operator?.close();
  });
});

// ---------------------------------------------------------------------------
// R-2: screenshots carry the coordinate mapping; send_input documents it.

const SCREEN = { left: -1920, top: 0, width: 3840, height: 1080 };

describe("R-2 take_screenshot coordinate metadata", () => {
  it("returns the image plus a text item with imageWidth, imageHeight and the virtual-screen rect", async () => {
    const data = Buffer.from("png").toString("base64");
    const agent = createFakeGuestAgent({
      handlers: {
        screenshot: () => ({ mimeType: "image/png", width: 1920, height: 540, data, screen: SCREEN }),
      },
    });
    const { call } = await connect(BASE_ENV, { runCommand: fakePrlctl(), spawnProcess: agent.spawnProcess });

    const result = await call("take_screenshot", { vmId: VM_ID });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "image", mimeType: "image/png", data }),
    );
    const metadata = textPayloads(result).find(
      (payload) => isRecord(payload) && "imageWidth" in payload,
    );
    expect(metadata).toMatchObject({ imageWidth: 1920, imageHeight: 540, screen: SCREEN });
  });

  it("describes how to map screenshot pixels to send_input click coordinates", async () => {
    const connection = await connect(BASE_ENV, {
      runCommand: fakePrlctl(),
      spawnProcess: createFakeGuestAgent().spawnProcess,
    });

    const sendInput = (await connection.tools()).find(({ name }) => name === "send_input");

    expect(sendInput?.description).toContain("imageWidth");
    expect(sendInput?.description).toContain("screen.left");
  });
});

// ---------------------------------------------------------------------------
// NS1 (amends R-7): invalid tool input is an INVALID_REQUEST tool error, never -32042 or -32602.

describe("NS1 invalid input tool error", () => {
  it.each([
    ["ui_snapshot", { scope: { maxDepth: -1 } }],
    ["ui_find", { locator: {} }],
    ["send_input", { action: "type" }],
    ["vm_restore", { confirm: false }],
  ] as const)("%s returns INVALID_REQUEST without contacting the agent or prlctl", async (tool, args) => {
    const agent = readyAgent();
    const runCommand = fakePrlctl();
    const connection = await connect(BASE_ENV, { runCommand, spawnProcess: agent.spawnProcess });

    await expectHostRejected(connection, agent, tool, args);
    expect(runCommand).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NS2: an unknown top-level key is INVALID_REQUEST, never silently stripped before the strict schema.
// Each input is otherwise valid, so the unknown key is the only reason to reject it.

describe("NS2 unknown top-level keys are rejected host-side", () => {
  it.each([
    ["list_windows", { extra: true }],
    ["focus_window", { handle: 1001, extra: true }],
    ["ui_snapshot", { extra: true }],
    ["ui_find", { locator: { role: "Button" }, extra: true }],
    ["ui_interact", { commands: [{ type: "snapshot" }], extra: true }],
  ] as const)(
    "%s rejects an unknown top-level key with INVALID_REQUEST without contacting the agent",
    async (tool, args) => {
      const agent = readyAgent();
      const connection = await connect(BASE_ENV, { runCommand: fakePrlctl(), spawnProcess: agent.spawnProcess });

      await expectHostRejected(connection, agent, tool, args);
    },
  );
});

// ---------------------------------------------------------------------------
// NN2: screenshot metadata degrades gracefully when the agent omits fields.

describe("NN2 take_screenshot partial metadata", () => {
  const data = Buffer.from("png").toString("base64");

  it("returns {imageWidth, imageHeight} without screen when the agent omits screen", async () => {
    const agent = createFakeGuestAgent({
      handlers: { screenshot: () => ({ mimeType: "image/png", width: 1568, height: 858, data }) },
    });
    const { call } = await connect(BASE_ENV, { runCommand: fakePrlctl(), spawnProcess: agent.spawnProcess });

    const result = await call("take_screenshot", { vmId: VM_ID });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContainEqual(expect.objectContaining({ type: "image", data }));
    const texts = result.content.filter((item) => item.type === "text");
    expect(texts).toHaveLength(1);
    expect(JSON.parse(texts[0]!.text as string)).toStrictEqual({ imageWidth: 1568, imageHeight: 858 });
  });

  it("returns only the image item when the agent omits width and height", async () => {
    const agent = createFakeGuestAgent({
      handlers: { screenshot: () => ({ mimeType: "image/png", data }) },
    });
    const { call } = await connect(BASE_ENV, { runCommand: fakePrlctl(), spawnProcess: agent.spawnProcess });

    const result = await call("take_screenshot", { vmId: VM_ID });

    expect(result.isError).toBeFalsy();
    expect(result.content).toStrictEqual([{ type: "image", mimeType: "image/png", data }]);
  });
});

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  SemanticAgentClient,
  SemanticAgentError,
  type AgentCommand,
  type SemanticErrorDetails,
  type SemanticCommand,
  type SemanticLocator,
  type SemanticScope,
  type SpawnImplementation,
} from "./semantic-agent-client.js";

export { SemanticAgentClient } from "./semantic-agent-client.js";
export type {
  AgentCommand,
  SemanticAction,
  SemanticAssertion,
  SemanticCandidateSummary,
  SemanticCommand,
  SemanticErrorDetails,
  SemanticLocator,
  SemanticNode,
  SemanticScope,
  SemanticSnapshotTruncation,
} from "./semantic-agent-client.js";

const execFileAsync = promisify(execFile);
// package.json sits one level above both src/ and dist/ (and in the installed package).
const SERVER_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string })
  .version;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POWERSHELL_MAX_LENGTH = 8_192;
const EXEC_TIMEOUT_MS = 30_000;
const INPUT_TEXT_MAX_LENGTH = 16_384;
const INPUT_KEYS_MAX_LENGTH = 64;
/** The only snapshot transversals owns and will ever switch to. */
export const OWNED_SNAPSHOT_NAME = "transversals-baseline";
const RESTORE_READINESS_INTERVAL_MS = 2_000;
const RESTORE_READINESS_TIMEOUT_MS = 180_000;
const PRLCTL_TIMEOUT_MS = 30_000;
const PRLCTL_MAX_BUFFER = 1024 * 1024;
const SHARE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export type PrlctlRequest =
  | { operation: "status" | "start" | "snapshot-list"; vmId: string }
  | {
      operation: "restore-snapshot";
      vmId: string;
      snapshotId: string;
    }
  /** `prlctl list -a -j`: every registered VM, as JSON. */
  | { operation: "list-all" }
  /** Adds a host folder shared into the guest as `\\Mac\<shareName>`. */
  | {
      operation: "share-add";
      vmId: string;
      shareName: string;
      hostPath: string;
      readOnly: boolean;
    }
  | { operation: "share-remove"; vmId: string; shareName: string }
  | { operation: "snapshot-create"; vmId: string; name: string }
  /** Deletes one snapshot by id (never by name). */
  | { operation: "snapshot-delete"; vmId: string; snapshotId: string }
  /** `prlctl exec <vm> --current-user <command...>` (no shell on the host). */
  | { operation: "exec"; vmId: string; command: readonly string[] };

type Command = { executable: string; args: readonly string[] };

export type RunCommand = (
  executable: string,
  args: readonly string[],
  options: { shell: false; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export type EnvironmentOperatorDeps = {
  /** Runs every prlctl lifecycle/snapshot call. Defaults to execFile without a shell. */
  runCommand?: RunCommand;
  /** Spawns the `prlctl exec ... <guest agent>` relay. Defaults to child_process.spawn. */
  spawnProcess?: SpawnImplementation;
};

type ExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
};

export type GuestInput =
  | { action: "type"; text: string }
  | { action: "keys"; keys: string }
  | {
      action: "click";
      x: number;
      y: number;
      button?: "left" | "right";
      double?: boolean;
    };

type Operator = {
  getStatus: (vmId: string) => Promise<unknown>;
  start: (vmId: string) => Promise<unknown>;
  runPowerShell: (vmId: string, script: string) => Promise<unknown>;
  takeScreenshot: (vmId: string) => Promise<unknown>;
  sendInput: (vmId: string, input: GuestInput) => Promise<unknown>;
  listWindows: (vmId: string) => Promise<unknown>;
  focusWindow: (vmId: string, handle: number) => Promise<unknown>;
  uiSnapshot: (vmId: string, scope?: SemanticScope) => Promise<unknown>;
  uiFind: (
    vmId: string,
    locator: SemanticLocator,
    scope?: SemanticScope,
  ) => Promise<unknown>;
  uiInteract: (vmId: string, commands: SemanticCommand[]) => Promise<unknown>;
  restore: (vmId: string) => Promise<unknown>;
};

type EnvironmentOperator = Operator & { close: () => Promise<void> };

type ErrorCode =
  | "AGENT_UNAVAILABLE"
  | "CONFIGURATION_ERROR"
  | "INVALID_IDENTIFIER"
  | "OPERATION_FAILED"
  | "PRLCTL_FAILED"
  | "READINESS_TIMEOUT"
  | "SNAPSHOT_AMBIGUOUS"
  | "SNAPSHOT_NOT_FOUND"
  | "UPSTREAM_ERROR"
  | "NOT_FOUND"
  | "AMBIGUOUS_MATCH"
  | "STALE_REFERENCE"
  | "CAPABILITY_UNAVAILABLE"
  | "ASSERTION_FAILED"
  | "ASSERTION_TIMEOUT"
  | "INVALID_REQUEST"
  | "ELEMENT_UNAVAILABLE"
  | "ACCESS_DENIED"
  | "BACKEND_FAILURE";

export class OperatorError extends Error {
  readonly code: ErrorCode;
  readonly commandIndex?: number;
  readonly details?: SemanticErrorDetails;

  constructor(
    code: ErrorCode,
    message: string,
    details?: {
      commandIndex?: number;
      details?: SemanticErrorDetails;
      cause?: unknown;
    },
  ) {
    super(message, details?.cause === undefined ? undefined : { cause: details.cause });
    this.name = "OperatorError";
    this.code = code;
    this.commandIndex = details?.commandIndex;
    this.details = details?.details;
  }
}

function requireCanonicalUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new OperatorError(
      "INVALID_IDENTIFIER",
      `${label} must be a canonical UUID`,
    );
  }
  return value;
}

export function normalizeConfiguredUuid(value: string | undefined, label: string): string {
  if (!value) {
    throw new OperatorError("CONFIGURATION_ERROR", `${label} is required`);
  }

  const normalized =
    value.startsWith("{") && value.endsWith("}") ? value.slice(1, -1) : value;
  return requireCanonicalUuid(normalized.toLowerCase(), label);
}

function requireShareName(value: string): string {
  if (!SHARE_NAME_PATTERN.test(value)) {
    throw new OperatorError("INVALID_IDENTIFIER", "shareName is not a valid share name");
  }
  return value;
}

export function buildPrlctlCommand(request: PrlctlRequest): Command {
  if (request.operation === "list-all") {
    return { executable: "prlctl", args: ["list", "-a", "-j"] };
  }
  const vmId = requireCanonicalUuid(request.vmId, "vmId");
  if (request.operation === "share-add") {
    if (!request.hostPath.startsWith("/")) {
      throw new OperatorError("INVALID_IDENTIFIER", "hostPath must be absolute");
    }
    return {
      executable: "prlctl",
      args: [
        "set",
        vmId,
        "--shf-host-add",
        requireShareName(request.shareName),
        "--path",
        request.hostPath,
        "--mode",
        request.readOnly ? "ro" : "rw",
      ],
    };
  }
  if (request.operation === "share-remove") {
    return {
      executable: "prlctl",
      args: ["set", vmId, "--shf-host-del", requireShareName(request.shareName)],
    };
  }
  if (request.operation === "snapshot-create") {
    if (request.name.trim().length === 0) {
      throw new OperatorError("INVALID_IDENTIFIER", "snapshot name is required");
    }
    return { executable: "prlctl", args: ["snapshot", vmId, "--name", request.name] };
  }
  if (request.operation === "exec") {
    if (request.command.length === 0) {
      throw new OperatorError("INVALID_IDENTIFIER", "exec command is required");
    }
    return {
      executable: "prlctl",
      args: ["exec", vmId, "--current-user", ...request.command],
    };
  }
  if (request.operation === "restore-snapshot") {
    const snapshotId = requireCanonicalUuid(request.snapshotId, "snapshotId");
    return {
      executable: "prlctl",
      args: ["snapshot-switch", vmId, "--id", snapshotId],
    };
  }
  if (request.operation === "snapshot-list") {
    return { executable: "prlctl", args: ["snapshot-list", vmId, "-j"] };
  }
  if (request.operation === "snapshot-delete") {
    const snapshotId = requireCanonicalUuid(request.snapshotId, "snapshotId");
    return {
      executable: "prlctl",
      args: ["snapshot-delete", vmId, "--id", snapshotId],
    };
  }

  return { executable: "prlctl", args: [request.operation, vmId] };
}

export function parsePrlctlStatus(
  raw: string,
): "running" | "paused" | "stopped" | "suspended" | "unknown" {
  const match = raw.match(/\bexist\s+(running|paused|stopped|suspended)\b/i);
  const status = match?.[1]?.toLowerCase();
  return status === "running" ||
    status === "paused" ||
    status === "stopped" ||
    status === "suspended"
    ? status
    : "unknown";
}

export async function waitForReadiness(
  probe: () => Promise<boolean>,
  options: { intervalMs: number; timeoutMs: number },
): Promise<void> {
  if (
    !Number.isFinite(options.intervalMs) ||
    options.intervalMs <= 0 ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0
  ) {
    throw new OperatorError(
      "CONFIGURATION_ERROR",
      "Readiness interval and timeout must be positive finite numbers",
    );
  }

  const deadline = Date.now() + options.timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new OperatorError(
        "READINESS_TIMEOUT",
        `Readiness timed out after ${options.timeoutMs}ms`,
      );
    }

    let timer: NodeJS.Timeout | undefined;
    const timeoutError = new OperatorError(
      "READINESS_TIMEOUT",
      `Readiness timed out after ${options.timeoutMs}ms`,
    );
    try {
      const ready = await Promise.race([
        Promise.resolve().then(probe),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(timeoutError),
            remaining,
          );
        }),
      ]);
      if (ready) return;
    } catch (error) {
      if (error === timeoutError) throw error;
      // A booting guest commonly refuses or resets connections. Retry until bounded.
    } finally {
      if (timer) clearTimeout(timer);
    }

    const waitRemaining = deadline - Date.now();
    if (waitRemaining <= 0) {
      throw new OperatorError(
        "READINESS_TIMEOUT",
        `Readiness timed out after ${options.timeoutMs}ms`,
      );
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(options.intervalMs, waitRemaining)),
    );
  }
}

function secretRedactor(secret?: string): (value: unknown) => string {
  return (value: unknown): string => {
    const raw = value instanceof Error ? value.message : String(value);
    let safe = raw.replace(/Bearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]");
    if (secret) safe = safe.split(secret).join("[REDACTED]");
    return safe;
  };
}

function asOperatorError(error: unknown, redact: (value: unknown) => string): OperatorError {
  if (error instanceof OperatorError) {
    return new OperatorError(error.code, redact(error.message), {
      commandIndex: error.commandIndex,
      details: error.details,
      cause: error,
    });
  }
  if (error instanceof SemanticAgentError) {
    return new OperatorError(error.code as ErrorCode, redact(error.message), {
      commandIndex: error.commandIndex,
      details: error.details,
      cause: error,
    });
  }
  return new OperatorError("OPERATION_FAILED", redact(error), { cause: error });
}

function audit(
  operation: string,
  phase: "start" | "end" | "failure",
  error?: OperatorError,
): void {
  const event: Record<string, string> = {
    event: "transversals",
    operation,
    phase,
  };
  if (error) event.code = error.code;
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

async function audited<T>(
  operation: string,
  redact: (value: unknown) => string,
  action: () => Promise<T>,
): Promise<T> {
  audit(operation, "start");
  try {
    const result = await action();
    audit(operation, "end");
    return result;
  } catch (error) {
    const safeError = asOperatorError(error, redact);
    audit(operation, "failure", safeError);
    throw safeError;
  }
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function successResult(value: unknown): CallToolResult {
  if (isCallToolResult(value)) return value;
  const structuredContent = { result: value ?? null };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function errorResult(error: unknown): CallToolResult {
  const safe = asOperatorError(error, secretRedactor());
  const structuredContent = {
    error: {
      code: safe.code,
      message: safe.message,
      ...(safe.commandIndex === undefined
        ? {}
        : { commandIndex: safe.commandIndex }),
      ...(safe.details === undefined ? {} : { details: safe.details }),
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

const vmIdSchema = z
  .string()
  .regex(UUID_PATTERN, "vmId must be a canonical UUID");

const locatorTextSchema = z.string().trim().min(1).max(1_024);
const semanticLocatorSchema: z.ZodType<SemanticLocator> = z.lazy(() =>
  z
    .object({
      automationId: locatorTextSchema.optional(),
      role: locatorTextSchema.optional(),
      name: locatorTextSchema.optional(),
      text: locatorTextSchema.optional(),
      value: locatorTextSchema.optional(),
      ancestor: semanticLocatorSchema.optional(),
      descendant: semanticLocatorSchema.optional(),
      sibling: semanticLocatorSchema.optional(),
      fuzzy: z.boolean().optional(),
      index: z.number().int().min(0).optional(),
    })
    .strict()
    .refine(
      (locator: SemanticLocator) =>
        locator.automationId !== undefined ||
        locator.role !== undefined ||
        locator.name !== undefined ||
        locator.text !== undefined ||
        locator.value !== undefined ||
        locator.ancestor !== undefined ||
        locator.descendant !== undefined ||
        locator.sibling !== undefined,
      "locator must contain semantic criteria",
    ),
);

const semanticScopeSchema: z.ZodType<SemanticScope> = z
  .object({
    processId: z.number().int().positive().optional(),
    windowName: locatorTextSchema.optional(),
    windowLocator: semanticLocatorSchema.optional(),
    maxDepth: z.number().int().min(0).max(64).optional(),
    maxNodes: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();

const semanticAssertionSchema = z
  .object({
    property: locatorTextSchema,
    equals: z.string().max(4_096).optional(),
    notEquals: z.string().max(4_096).optional(),
    contains: z.string().max(4_096).optional(),
    exists: z.boolean().optional(),
  })
  .strict()
  .refine(
    (assertion) =>
      assertion.equals !== undefined ||
      assertion.notEquals !== undefined ||
      assertion.contains !== undefined ||
      assertion.exists !== undefined,
    "assertion must contain an expected condition",
  );

const semanticActionSchema = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.enum(["invoke", "focus", "toggle", "expand", "collapse"]) }).strict(),
    z
      .object({
        type: z.enum(["value", "select"]),
        value: z.string().max(16_384),
      })
      .strict(),
  ],
  {
    error: (issue) =>
      issue.code === "invalid_union"
        ? "action.type must be one of: invoke, focus, toggle, expand, collapse (no other fields), or value, select (with value)"
        : undefined,
  },
);

const snapshotCommandSchema = z
  .object({ type: z.literal("snapshot"), scope: semanticScopeSchema.optional() })
  .strict();
const findCommandSchema = z
  .object({
    type: z.literal("find"),
    locator: semanticLocatorSchema,
    scope: semanticScopeSchema.optional(),
  })
  .strict();
const interactCommandSchema = z
  .object({
    type: z.literal("interact"),
    ref: locatorTextSchema,
    action: semanticActionSchema,
  })
  .strict();
const assertByReferenceSchema = z
  .object({
    type: z.literal("assert"),
    ref: locatorTextSchema,
    assertion: semanticAssertionSchema,
  })
  .strict();
const assertByLocatorSchema = z
  .object({
    type: z.literal("assert"),
    locator: semanticLocatorSchema,
    assertion: semanticAssertionSchema,
    scope: semanticScopeSchema.optional(),
  })
  .strict();
const waitCommandSchema = z
  .object({
    type: z.literal("wait"),
    locator: semanticLocatorSchema,
    assertion: semanticAssertionSchema,
    timeoutMs: z.number().int().min(0).max(120_000).optional(),
    pollIntervalMs: z.number().int().min(1).max(10_000).optional(),
    scope: semanticScopeSchema.optional(),
  })
  .strict();
const SEMANTIC_COMMAND_TYPES = "snapshot, find, interact, assert, wait";

/** The strict schema for one command, chosen by its `type` (assert: by `ref`, else by `locator`). */
function semanticCommandBranch(command: Record<string, unknown>): z.ZodType | undefined {
  switch (command.type) {
    case "snapshot":
      return snapshotCommandSchema;
    case "find":
      return findCommandSchema;
    case "interact":
      return interactCommandSchema;
    case "assert":
      return command.ref !== undefined
        ? assertByReferenceSchema
        : command.locator !== undefined
          ? assertByLocatorSchema
          : undefined;
    case "wait":
      return waitCommandSchema;
    default:
      return undefined;
  }
}

// Dispatches on `type` instead of a plain union, whose only error is "Invalid input": an unknown type
// lists the valid ones, and a known type reports that branch's field-level issues with their paths.
const semanticCommandSchema: z.ZodType<SemanticCommand> = z.unknown().transform((value, ctx) => {
  if (!isRecord(value)) {
    ctx.addIssue({ code: "custom", message: `Each command must be an object whose type is one of: ${SEMANTIC_COMMAND_TYPES}` });
    return z.NEVER;
  }
  const branch = semanticCommandBranch(value);
  if (branch === undefined) {
    ctx.addIssue(
      value.type === "assert"
        ? { code: "custom", message: "assert needs either ref (a found element) or locator (with optional scope), plus assertion" }
        : { code: "custom", path: ["type"], message: `type must be one of: ${SEMANTIC_COMMAND_TYPES}` },
    );
    return z.NEVER;
  }
  const parsed = branch.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
    return z.NEVER;
  }
  return parsed.data as SemanticCommand;
});

const SEMANTIC_COMMANDS_DESCRIPTION = [
  "Required. 1-50 commands run in order; the batch stops at the first failure. Each command is an object with a type:",
  '- {"type":"snapshot","scope"?} - UI tree of all top-level windows, or only those matching scope.',
  '- {"type":"find","locator","scope"?} - find one element.',
  '- {"type":"interact","ref","action"} - action is {"type":"invoke"|"focus"|"toggle"|"expand"|"collapse"} or {"type":"value"|"select","value":"..."}.',
  '- {"type":"assert","ref","assertion"} or {"type":"assert","locator","assertion","scope"?} - check one property now.',
  '- {"type":"wait","locator","assertion","timeoutMs"?,"pollIntervalMs"?,"scope"?} - poll until the assertion holds; timeoutMs default 10000 (0-120000), pollIntervalMs default 100 (1-10000).',
  'ref: a reference from a snapshot/find result, or "$last" (the element from the most recent find, assert or wait in this batch; after a snapshot, its root).',
  "locator: at least one of automationId, role, name, text, value, ancestor, descendant, sibling (nested locators); optional fuzzy, index.",
  "scope (all optional): processId, windowName, windowLocator, maxDepth default 12 (0-64), maxNodes default 1000 (1-10000).",
  'assertion: {"property", plus at least one of "equals", "notEquals", "contains" (strings) or "exists" (boolean: value is non-empty)}.',
  "property: Role, Name, AutomationId, ClassName, ProcessId, WindowHandle, IsEnabled, IsOffscreen, HasKeyboardFocus, Value, Text, Capabilities (comma-joined). Names and comparisons ignore case; booleans compare as True/False.",
  'Example: [{"type":"find","locator":{"role":"Button","name":"Stop"}},{"type":"interact","ref":"$last","action":{"type":"invoke"}}]',
].join("\n");

const inputTextSchema = z.string().min(1).max(INPUT_TEXT_MAX_LENGTH);
const inputKeysSchema = z.string().min(1).max(INPUT_KEYS_MAX_LENGTH);
const inputButtonSchema = z.enum(["left", "right"]);
const windowHandleSchema = z.number().int().positive();

// Advertised to clients. Like the ui_* tools, it is deliberately permissive
// (loose, unknown-typed fields); every rule, including rejecting unknown keys,
// is enforced by the strict schema in createServer and reported as INVALID_REQUEST.
const sendInputToolSchema = z.looseObject({
  vmId: vmIdSchema,
  action: z
    .unknown()
    .optional()
    .describe('Required. "type" (send text), "keys" (press a key chord), or "click".'),
  text: z.unknown().optional().describe("action=type: text to type, 1-16384 chars."),
  keys: z
    .unknown()
    .optional()
    .describe("action=keys: key chord such as enter or ctrl+shift+s, 1-64 chars."),
  x: z.unknown().optional().describe("action=click: integer virtual-screen pixel x."),
  y: z.unknown().optional().describe("action=click: integer virtual-screen pixel y."),
  button: z.unknown().optional().describe('action=click: "left" (default) or "right".'),
  double: z.unknown().optional().describe("action=click: true for a double-click."),
});

const sendInputSchema = z.discriminatedUnion("action", [
  z
    .object({ vmId: vmIdSchema, action: z.literal("type"), text: inputTextSchema })
    .strict(),
  z
    .object({ vmId: vmIdSchema, action: z.literal("keys"), keys: inputKeysSchema })
    .strict(),
  z
    .object({
      vmId: vmIdSchema,
      action: z.literal("click"),
      x: z.number().int(),
      y: z.number().int(),
      button: inputButtonSchema.optional(),
      double: z.boolean().optional(),
    })
    .strict(),
]);

export function createServer(operator: Operator): McpServer {
  const server = new McpServer({ name: "transversals-mcp", version: SERVER_VERSION });

  /**
   * `inputSchema` is what clients see in tools/list. `strictSchema`, when given,
   * is the full rule set (unknown keys, action-specific fields) that the
   * advertised schema is too permissive to express.
   */
  const register = <T extends { vmId: string }>(
    name: string,
    description: string,
    inputSchema: Record<string, z.ZodType> | z.ZodObject,
    handler: (input: T) => Promise<unknown>,
    strictSchema?: z.ZodType<T>,
  ): void => {
    // Raw shapes get the same z.object wrapping the SDK applies internally.
    const schema: z.ZodObject =
      inputSchema instanceof z.ZodObject ? inputSchema : z.object(inputSchema);
    const validator = (strictSchema ?? schema) as z.ZodType<T>;
    server.registerTool(name, { description, inputSchema: schema }, async (input) => {
      // Per MCP 2025-11-25 (SEP-1303), invalid input is a tool execution error the
      // model can read and correct, so it never reaches the agent or prlctl.
      const parsed = validator.safeParse(input);
      if (!parsed.success) {
        return errorResult(
          new OperatorError(
            "INVALID_REQUEST",
            `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`,
          ),
        );
      }
      try {
        return successResult(await handler(parsed.data));
      } catch (error) {
        return errorResult(error);
      }
    });
  };

  register<{ vmId: string }>(
    "vm_status",
    "Get the configured Parallels VM status.",
    { vmId: vmIdSchema },
    ({ vmId }) => operator.getStatus(vmId),
  );
  register<{ vmId: string }>(
    "vm_start",
    "Start the configured Parallels VM.",
    { vmId: vmIdSchema },
    ({ vmId }) => operator.start(vmId),
  );
  register<{ vmId: string; script: string }>(
    "run_powershell",
    "Run bounded PowerShell in the guest interactive session.",
    {
      vmId: vmIdSchema,
      script: z.string().min(1).max(POWERSHELL_MAX_LENGTH),
    },
    ({ vmId, script }) => operator.runPowerShell(vmId, script),
  );
  register<{ vmId: string }>(
    "take_screenshot",
    "Capture screenshot evidence from the guest interactive session.",
    { vmId: vmIdSchema },
    ({ vmId }) => operator.takeScreenshot(vmId),
  );
  register<{ vmId: string } & GuestInput>(
    "send_input",
    "Type text, press a key chord such as ctrl+shift+s, or click at virtual-screen pixel coordinates in the guest's interactive session. " +
      "Click x/y are virtual-screen pixels, not screenshot pixels: take_screenshot returns {imageWidth, imageHeight, screen} next to the image, " +
      "so for a point (px, py) in the screenshot use x = screen.left + px * screen.width / imageWidth and " +
      "y = screen.top + py * screen.height / imageHeight, rounded to integers.",
    sendInputToolSchema,
    ({ vmId, ...input }) => operator.sendInput(vmId, input as GuestInput),
    sendInputSchema,
  );
  register<{ vmId: string }>(
    "list_windows",
    "List top-level windows in the guest's interactive session with their handles, titles, and owning processes.",
    z.looseObject({ vmId: vmIdSchema }),
    ({ vmId }) => operator.listWindows(vmId),
    z.object({ vmId: vmIdSchema }).strict(),
  );
  register<{ vmId: string; handle: number }>(
    "focus_window",
    "Bring a guest window to the foreground by handle from list_windows.",
    z.looseObject({
      vmId: vmIdSchema,
      handle: z
        .unknown()
        .optional()
        .describe("Required. Positive integer window handle from list_windows."),
    }),
    ({ vmId, handle }) => operator.focusWindow(vmId, handle),
    z.object({ vmId: vmIdSchema, handle: windowHandleSchema }).strict(),
  );
  register<{ vmId: string; scope?: SemanticScope }>(
    "ui_snapshot",
    "Capture a bounded semantic UI Automation tree from the guest.",
    { vmId: vmIdSchema, scope: z.unknown().optional() },
    ({ vmId, scope }) =>
      scope === undefined
        ? operator.uiSnapshot(vmId)
        : operator.uiSnapshot(vmId, scope),
    z.object({ vmId: vmIdSchema, scope: semanticScopeSchema.optional() }).strict(),
  );
  register<{
    vmId: string;
    locator: SemanticLocator;
    scope?: SemanticScope;
  }>(
    "ui_find",
    "Find one guest UI element with a semantic locator.",
    {
      vmId: vmIdSchema,
      locator: z.unknown(),
      scope: z.unknown().optional(),
    },
    ({ vmId, locator, scope }) =>
      scope === undefined
        ? operator.uiFind(vmId, locator)
        : operator.uiFind(vmId, locator, scope),
    z
      .object({
        vmId: vmIdSchema,
        locator: semanticLocatorSchema,
        scope: semanticScopeSchema.optional(),
      })
      .strict(),
  );
  register<{ vmId: string; commands: SemanticCommand[] }>(
    "ui_interact",
    "Run an ordered fail-fast semantic UI command batch in the guest.",
    {
      vmId: vmIdSchema,
      // Advertised as a description only, so any input still reaches the strict schema's INVALID_REQUEST.
      commands: z.unknown().describe(SEMANTIC_COMMANDS_DESCRIPTION),
    },
    ({ vmId, commands }) => operator.uiInteract(vmId, commands),
    z
      .object({
        vmId: vmIdSchema,
        commands: z.array(semanticCommandSchema).min(1).max(50),
      })
      .strict(),
  );
  register<{ vmId: string; confirm: true }>(
    "vm_restore",
    `Restore the configured VM to the "${OWNED_SNAPSHOT_NAME}" snapshot created by \`transversals setup\`, then wait for the guest agent. DESTRUCTIVE: discards all guest changes made since that baseline. Requires confirm: true.`,
    z.looseObject({
      vmId: vmIdSchema,
      confirm: z
        .unknown()
        .optional()
        .describe("Required. Must be literally true to acknowledge that guest changes are discarded."),
    }),
    ({ vmId }) => operator.restore(vmId),
    z.object({ vmId: vmIdSchema, confirm: z.literal(true) }).strict(),
  );

  return server;
}

function requireNonEmpty(value: string | undefined, label: string): string {
  if (!value || value.trim().length === 0) {
    throw new OperatorError("CONFIGURATION_ERROR", `${label} is required`);
  }
  return value;
}

export const defaultRunCommand: RunCommand = async (executable, args, options) => {
  const { stdout, stderr } = await execFileAsync(executable, [...args], {
    encoding: "utf8",
    ...options,
  });
  return { stdout, stderr };
};

/**
 * Runs one validated prlctl request without a shell and returns trimmed stdout.
 * Failures become PRLCTL_FAILED with the raw runCommand error as `cause`.
 */
export async function runPrlctl(
  runCommand: RunCommand,
  request: PrlctlRequest,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const command = buildPrlctlCommand(request);
  try {
    const { stdout } = await runCommand(command.executable, command.args, {
      shell: false,
      timeout: options.timeoutMs ?? PRLCTL_TIMEOUT_MS,
      maxBuffer: PRLCTL_MAX_BUFFER,
    });
    return stdout.trim();
  } catch (error) {
    throw new OperatorError("PRLCTL_FAILED", secretRedactor()(error), { cause: error });
  }
}

/**
 * Raw ids (as keyed by prlctl, e.g. braced) of every `prlctl snapshot-list -j`
 * entry named OWNED_SNAPSHOT_NAME. Normalize with normalizeConfiguredUuid before use.
 */
export function parseOwnedSnapshotIds(raw: string): string[] {
  let parsed: unknown = {};
  if (raw.trim().length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new OperatorError(
        "OPERATION_FAILED",
        "prlctl snapshot-list returned unparseable output",
        { cause: error },
      );
    }
  }
  if (!isRecord(parsed)) {
    throw new OperatorError(
      "OPERATION_FAILED",
      "prlctl snapshot-list returned an unexpected shape",
    );
  }

  return Object.entries(parsed)
    .filter(([, entry]) => isRecord(entry) && entry.name === OWNED_SNAPSHOT_NAME)
    .map(([id]) => id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedAgentResult(command: string): OperatorError {
  return new OperatorError(
    "UPSTREAM_ERROR",
    `Guest agent returned a malformed ${command} result`,
  );
}

function parseExecResult(value: unknown): ExecResult {
  if (
    !isRecord(value) ||
    !(value.exitCode === null || Number.isInteger(value.exitCode)) ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string"
  ) {
    throw malformedAgentResult("exec");
  }
  return {
    exitCode: value.exitCode as number | null,
    stdout: value.stdout,
    stderr: value.stderr,
    stdoutTruncated: value.stdoutTruncated === true,
    stderrTruncated: value.stderrTruncated === true,
    timedOut: value.timedOut === true,
  };
}

type ScreenRect = { left: number; top: number; width: number; height: number };

function isScreenRect(value: unknown): value is ScreenRect {
  return (
    isRecord(value) &&
    Number.isInteger(value.left) &&
    Number.isInteger(value.top) &&
    Number.isInteger(value.width) &&
    Number.isInteger(value.height)
  );
}

/**
 * The image plus the metadata clients need to map image pixels to send_input
 * coordinates. Agents installed before `screen` was reported still yield the
 * image, with whatever metadata they sent.
 */
function parseScreenshotResult(value: unknown): CallToolResult {
  if (!isRecord(value) || typeof value.data !== "string" || value.data.length === 0) {
    throw malformedAgentResult("screenshot");
  }
  const content: CallToolResult["content"] = [
    { type: "image", mimeType: "image/png", data: value.data },
  ];
  if (Number.isInteger(value.width) && Number.isInteger(value.height)) {
    const screen = isScreenRect(value.screen)
      ? {
          left: value.screen.left,
          top: value.screen.top,
          width: value.screen.width,
          height: value.screen.height,
        }
      : undefined;
    const metadata = {
      imageWidth: value.width as number,
      imageHeight: value.height as number,
      ...(screen === undefined ? {} : { screen }),
    };
    content.push({ type: "text", text: JSON.stringify(metadata) });
  }
  return { content };
}

export function createEnvironmentOperator(
  env: NodeJS.ProcessEnv,
  deps: EnvironmentOperatorDeps = {},
): EnvironmentOperator {
  const vmId = normalizeConfiguredUuid(env.TRANSVERSALS_VM_ID, "TRANSVERSALS_VM_ID");
  const semanticAgentExecutable = requireNonEmpty(
    env.TRANSVERSALS_UI_AGENT_EXECUTABLE,
    "TRANSVERSALS_UI_AGENT_EXECUTABLE",
  );
  const redact = secretRedactor();
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const semanticAgent =
    deps.spawnProcess === undefined
      ? new SemanticAgentClient(vmId, semanticAgentExecutable)
      : new SemanticAgentClient(vmId, semanticAgentExecutable, deps.spawnProcess);

  const agent = async (command: AgentCommand): Promise<unknown> => {
    const results = await semanticAgent.send([command]);
    return results[0];
  };
  const exec = async (script: string): Promise<ExecResult> =>
    parseExecResult(await agent({ type: "exec", script, timeoutMs: EXEC_TIMEOUT_MS }));
  const screenshot = async () => parseScreenshotResult(await agent({ type: "screenshot" }));

  const assertConfiguredVm = (candidate: string): void => {
    requireCanonicalUuid(candidate, "vmId");
    if (candidate !== vmId) {
      throw new OperatorError(
        "INVALID_IDENTIFIER",
        "vmId does not match the configured VM",
      );
    }
  };

  const prlctl = (request: PrlctlRequest): Promise<string> =>
    runPrlctl(runCommand, request);

  const getStatus = async (candidate: string): Promise<{ status: string; raw: string }> => {
    assertConfiguredVm(candidate);
    const raw = await prlctl({ operation: "status", vmId });
    return { status: parsePrlctlStatus(raw), raw };
  };

  const findOwnedSnapshotId = async (): Promise<string> => {
    const owned = parseOwnedSnapshotIds(
      await prlctl({ operation: "snapshot-list", vmId }),
    );
    if (owned.length === 0) {
      throw new OperatorError(
        "SNAPSHOT_NOT_FOUND",
        `No "${OWNED_SNAPSHOT_NAME}" snapshot exists for the configured VM. Run \`transversals setup\` to create it.`,
      );
    }
    if (owned.length > 1) {
      throw new OperatorError(
        "SNAPSHOT_AMBIGUOUS",
        `Found ${owned.length} "${OWNED_SNAPSHOT_NAME}" snapshots; delete the extras so exactly one remains.`,
      );
    }
    return normalizeConfiguredUuid(owned[0], "snapshot id");
  };

  const operator: EnvironmentOperator = {
    getStatus: (candidate) =>
      audited("vm_status", redact, () => getStatus(candidate)),
    start: (candidate) =>
      audited("vm_start", redact, async () => {
        assertConfiguredVm(candidate);
        const status = await getStatus(candidate);
        if (status.status === "running") return status;
        const output = await prlctl({ operation: "start", vmId });
        return { status: "starting", output };
      }),
    runPowerShell: (candidate, script) =>
      audited("run_powershell", redact, async () => {
        assertConfiguredVm(candidate);
        if (script.length < 1 || script.length > POWERSHELL_MAX_LENGTH) {
          throw new OperatorError(
            "OPERATION_FAILED",
            `PowerShell input must be 1-${POWERSHELL_MAX_LENGTH} characters`,
          );
        }
        return exec(script);
      }),
    takeScreenshot: (candidate) =>
      audited("take_screenshot", redact, async () => {
        assertConfiguredVm(candidate);
        return screenshot();
      }),
    sendInput: (candidate, input) =>
      audited("send_input", redact, async () => {
        assertConfiguredVm(candidate);
        return agent({ type: "input", ...input });
      }),
    listWindows: (candidate) =>
      audited("list_windows", redact, async () => {
        assertConfiguredVm(candidate);
        return agent({ type: "windows", action: "list" });
      }),
    focusWindow: (candidate, handle) =>
      audited("focus_window", redact, async () => {
        assertConfiguredVm(candidate);
        return agent({ type: "windows", action: "focus", handle });
      }),
    uiSnapshot: (candidate, scope) =>
      audited("ui_snapshot", redact, async () => {
        assertConfiguredVm(candidate);
        const results = await semanticAgent.execute([
          { type: "snapshot", ...(scope === undefined ? {} : { scope }) },
        ]);
        return results[0] ?? null;
      }),
    uiFind: (candidate, locator, scope) =>
      audited("ui_find", redact, async () => {
        assertConfiguredVm(candidate);
        const results = await semanticAgent.execute([
          {
            type: "find",
            locator,
            ...(scope === undefined ? {} : { scope }),
          },
        ]);
        return results[0] ?? null;
      }),
    uiInteract: (candidate, commands) =>
      audited("ui_interact", redact, async () => {
        assertConfiguredVm(candidate);
        return { results: await semanticAgent.execute(commands) };
      }),
    restore: (candidate) =>
      audited("vm_restore", redact, async () => {
        assertConfiguredVm(candidate);
        const snapshotId = await findOwnedSnapshotId();
        await prlctl({ operation: "restore-snapshot", vmId, snapshotId });
        await waitForReadiness(
          async () => {
            await agent({ type: "hello" });
            return true;
          },
          {
            intervalMs: RESTORE_READINESS_INTERVAL_MS,
            timeoutMs: RESTORE_READINESS_TIMEOUT_MS,
          },
        );
        return { snapshotId, name: OWNED_SNAPSHOT_NAME };
      }),
    close: async () => {
      await semanticAgent.close();
    },
  };
  return operator;
}

/**
 * Starts the MCP server on process stdio for the VM/agent in `env`
 * (TRANSVERSALS_VM_ID, TRANSVERSALS_UI_AGENT_EXECUTABLE). Resolves once connected;
 * the process keeps running until stdin closes or SIGINT/SIGTERM. On a start
 * failure it audits to stderr, cleans up, and rejects with an OperatorError.
 */
export async function startStdioServer(env: NodeJS.ProcessEnv): Promise<void> {
  const redact = secretRedactor();
  let operator: EnvironmentOperator | undefined;
  let server: McpServer | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= operator?.close() ?? Promise.resolve();
    return cleanupPromise;
  };
  const shutdown = (): void => {
    shutdownPromise ??= cleanup()
      .then(async () => {
        await server?.close();
      })
      .catch((error: unknown) => {
        const safe = asOperatorError(error, redact);
        audit("server_shutdown", "failure", safe);
        process.exitCode = 1;
      });
  };
  const inputClosed = (): void => shutdown();

  try {
    operator = createEnvironmentOperator(env);
    server = createServer(operator);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.stdin.once("end", inputClosed);
    process.stdin.once("close", inputClosed);
    server.server.onclose = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      process.stdin.off("end", inputClosed);
      process.stdin.off("close", inputClosed);
      void cleanup().catch((error: unknown) => {
        const safe = asOperatorError(error, redact);
        audit("server_shutdown", "failure", safe);
      });
    };
    await server.connect(new StdioServerTransport());
  } catch (error) {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    process.stdin.off("end", inputClosed);
    process.stdin.off("close", inputClosed);
    await cleanup();
    const safe = asOperatorError(error, redact);
    audit("server_start", "failure", safe);
    throw safe;
  }
}

async function main(): Promise<void> {
  try {
    await startStdioServer(process.env);
  } catch {
    // startStdioServer already audited the failure to stderr.
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entryPoint === import.meta.url) {
  void main();
}

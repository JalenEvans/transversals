import {
  spawn,
  type ChildProcessByStdio,
  type SpawnOptions,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const BASE_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const CHILD_EXIT_GRACE_MS = 2_000;
const CHILD_KILL_GRACE_MS = 1_000;
const MAX_AMBIGUOUS_CANDIDATES = 10;
/**
 * How often a blank keepalive line goes to a protocol v2+ agent. The agent exits after 30 s without
 * input, because a killed prlctl neither closes the agent's stdin nor fails its writes.
 */
export const KEEPALIVE_INTERVAL_MS = 5_000;
/** First agent protocol that ignores blank lines (older agents answer them with an id-less error). */
const KEEPALIVE_PROTOCOL_VERSION = 2;
const GUEST_ERROR_CODES = new Set([
  "NOT_FOUND",
  "AMBIGUOUS_MATCH",
  "STALE_REFERENCE",
  "CAPABILITY_UNAVAILABLE",
  "ASSERTION_FAILED",
  "ASSERTION_TIMEOUT",
  "INVALID_REQUEST",
  "ELEMENT_UNAVAILABLE",
  "ACCESS_DENIED",
  "BACKEND_FAILURE",
]);

export type SemanticLocator = {
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

export type SemanticScope = {
  processId?: number;
  windowName?: string;
  windowLocator?: SemanticLocator;
  maxDepth?: number;
  maxNodes?: number;
};

export type SemanticAssertion = {
  property: string;
  equals?: string;
  notEquals?: string;
  contains?: string;
  exists?: boolean;
};

export type SemanticCandidateSummary = {
  reference?: string;
  role: string;
  name?: string;
  text?: string;
  automationId?: string;
};

export type SemanticSnapshotTruncation = {
  truncated: true;
  reasons: Array<"maxNodes" | "maxDepth" | "utf8ByteBudget">;
  byteBudget?: number;
  includedNodes: number;
  omittedNodesAtLeast: number;
  truncatedFields: number;
};

export type SemanticNode = {
  id: string;
  reference?: string;
  role: string;
  name?: string;
  automationId?: string;
  className?: string;
  processId?: number;
  windowHandle?: number;
  isEnabled?: boolean;
  isOffscreen?: boolean;
  hasKeyboardFocus?: boolean;
  value?: string;
  text?: string;
  capabilities: string[];
  children: SemanticNode[];
  truncation?: SemanticSnapshotTruncation;
};

export type SemanticErrorDetails = {
  candidates: SemanticCandidateSummary[];
};

export type SemanticAction =
  | { type: "invoke" | "focus" | "toggle" | "expand" | "collapse" }
  | { type: "value" | "select"; value: string };

export type SemanticCommand =
  | { type: "snapshot"; scope?: SemanticScope }
  | { type: "find"; locator: SemanticLocator; scope?: SemanticScope }
  | { type: "interact"; ref: string; action: SemanticAction }
  | {
      type: "assert";
      assertion: SemanticAssertion;
      ref: string;
      locator?: never;
      scope?: never;
    }
  | {
      type: "assert";
      assertion: SemanticAssertion;
      locator: SemanticLocator;
      scope?: SemanticScope;
      ref?: never;
    }
  | {
      type: "wait";
      locator: SemanticLocator;
      assertion: SemanticAssertion;
      timeoutMs?: number;
      pollIntervalMs?: number;
      scope?: SemanticScope;
    };

/** A raw guest agent protocol command, e.g. `{ type: "exec", script, timeoutMs }`. */
export type AgentCommand = Record<string, unknown> & { type: string };

type GuestCommand = Record<string, unknown>;

const AGENT_UNAVAILABLE_HINT =
  "Run `transversals doctor` to check the VM, Parallels Tools and the guest agent install.";

type SemanticChild = ChildProcessByStdio<Writable, Readable, null>;
export type SpawnImplementation = (
  command: string,
  args: readonly string[],
  options: SpawnOptions & { stdio: ["pipe", "pipe", "ignore" | "inherit"] },
) => SemanticChild;

type PendingRequest = {
  id: string;
  commandCount: number;
  timer: NodeJS.Timeout;
  resolve: (results: unknown[]) => void;
  reject: (error: unknown) => void;
};

type ClientState = "open" | "closing" | "closed";

export class SemanticAgentError extends Error {
  readonly code: string;
  readonly commandIndex?: number;
  readonly details?: SemanticErrorDetails;

  constructor(
    code: string,
    message: string,
    options?: {
      commandIndex?: number;
      details?: SemanticErrorDetails;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SemanticAgentError";
    this.code = code;
    this.commandIndex = options?.commandIndex;
    this.details = options?.details;
  }
}

export class SemanticAgentClient {
  private child?: SemanticChild;
  private pending?: PendingRequest;
  private stdoutBuffer = "";
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;
  private state: ClientState = "open";
  private readonly terminations = new Map<SemanticChild, Promise<void>>();
  /** Children whose negotiation hello has succeeded. */
  private readonly negotiated = new WeakSet<SemanticChild>();
  private readonly keepalives = new Map<SemanticChild, NodeJS.Timeout>();

  constructor(
    private readonly vmId: string,
    private readonly executable: string,
    private readonly spawnProcess: SpawnImplementation = spawn as SpawnImplementation,
  ) {
    if (executable.trim().length === 0) {
      throw new SemanticAgentError(
        "CONFIGURATION_ERROR",
        "TRANSVERSALS_UI_AGENT_EXECUTABLE is required",
      );
    }
  }

  execute(commands: readonly SemanticCommand[]): Promise<unknown[]> {
    if (this.state !== "open") return Promise.reject(this.closedError());
    const guestCommands = commands.map((command) => this.toGuestCommand(command));
    return this.serialize(() => {
      if (this.state !== "open") throw this.closedError();
      return this.request(guestCommands, this.requestTimeout(commands));
    });
  }

  /**
   * Sends raw guest agent commands (hello, exec, screenshot, input, windows) as one
   * NDJSON request over the same serialized connection as `execute`. Any numeric
   * `timeoutMs` on a command extends the host-side request timeout.
   */
  send(commands: readonly AgentCommand[]): Promise<unknown[]> {
    if (this.state !== "open") return Promise.reject(this.closedError());
    const timeoutMs = Math.min(
      BASE_REQUEST_TIMEOUT_MS +
        commands.reduce(
          (total, command) =>
            total + (typeof command.timeoutMs === "number" ? command.timeoutMs : 0),
          0,
        ),
      MAX_REQUEST_TIMEOUT_MS,
    );
    return this.serialize(() => {
      if (this.state !== "open") throw this.closedError();
      return this.request(commands, timeoutMs);
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.state = "closing";
    const child = this.child;
    this.child = undefined;
    this.stdoutBuffer = "";
    if (child) this.stopKeepalive(child);
    this.rejectPending(this.closedError());

    const queued = this.queue;
    this.closePromise = queued
      .then(async () => {
        if (child) await this.trackTermination(child);
        await Promise.allSettled([...this.terminations.values()]);
      })
      .finally(() => {
        this.state = "closed";
      });
    return this.closePromise;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async request(
    commands: readonly GuestCommand[],
    timeoutMs: number,
  ): Promise<unknown[]> {
    const child = this.ensureChild();
    // Runs inside the serialized queue, so the negotiation hello always precedes the caller's request.
    // A failure rejects the caller with the same error and its commands are never sent.
    if (!this.negotiated.has(child)) await this.negotiate(child);
    return this.requestOn(child, commands, timeoutMs);
  }

  /**
   * Says hello on a new child and starts keepalives when the agent speaks protocol v2+. Older agents
   * answer a blank line with an id-less error the client treats as fatal, so they never get keepalives.
   */
  private async negotiate(child: SemanticChild): Promise<void> {
    const [hello] = await this.requestOn(child, [{ type: "hello" }], BASE_REQUEST_TIMEOUT_MS);
    this.negotiated.add(child);
    const version = isRecord(hello) ? hello.protocolVersion : undefined;
    if (typeof version === "number" && version >= KEEPALIVE_PROTOCOL_VERSION) this.startKeepalive(child);
  }

  private startKeepalive(child: SemanticChild): void {
    if (this.keepalives.has(child) || this.child !== child) return;
    const timer = setInterval(() => {
      const stdin = child.stdin;
      if (this.child !== child || child.exitCode !== null || stdin.destroyed || stdin.writableEnded) {
        this.stopKeepalive(child);
        return;
      }
      // A request (or an earlier keepalive) is still buffered: skip rather than queue behind it.
      if (stdin.writableLength > 0) return;
      try {
        stdin.write("\n", () => {
          // Errors are ignored: the child's exit/error events decide what happens next.
        });
      } catch {
        // stdin destroyed between the check and the write.
      }
    }, KEEPALIVE_INTERVAL_MS);
    this.keepalives.set(child, timer);
  }

  private stopKeepalive(child: SemanticChild): void {
    const timer = this.keepalives.get(child);
    if (timer === undefined) return;
    clearInterval(timer);
    this.keepalives.delete(child);
  }

  private async requestOn(
    child: SemanticChild,
    commands: readonly GuestCommand[],
    timeoutMs: number,
  ): Promise<unknown[]> {
    const id = `semantic-${++this.sequence}`;
    const line = `${JSON.stringify({ id, commands })}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) {
      throw new SemanticAgentError(
        "INVALID_REQUEST",
        "Semantic request exceeds the maximum size",
      );
    }

    return new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id !== id) return;
        this.pending = undefined;
        reject(
          new SemanticAgentError(
            "UPSTREAM_ERROR",
            `Semantic agent request timed out after ${timeoutMs}ms`,
          ),
        );
        void this.invalidate(child);
      }, timeoutMs);
      this.pending = { id, commandCount: commands.length, timer, resolve, reject };

      child.stdin.write(line, "utf8", (error) => {
        if (!error || this.pending?.id !== id) return;
        this.rejectPending(
          new SemanticAgentError(
            "UPSTREAM_ERROR",
            "Could not write to the semantic agent",
            { cause: error },
          ),
        );
        void this.invalidate(child);
      });
    });
  }

  private ensureChild(): SemanticChild {
    if (this.state !== "open") throw this.closedError();
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.child;
    }

    this.stdoutBuffer = "";
    let child: SemanticChild;
    try {
      child = this.spawnProcess(
        "prlctl",
        ["exec", this.vmId, "--current-user", this.executable],
        { shell: false, stdio: ["pipe", "pipe", "ignore"] },
      );
    } catch (error) {
      throw new SemanticAgentError(
        "AGENT_UNAVAILABLE",
        `Could not start the guest agent. ${AGENT_UNAVAILABLE_HINT}`,
        { cause: error },
      );
    }
    this.child = child;
    // Write failures (e.g. EPIPE once prlctl is gone) arrive through write callbacks and the child's
    // exit/error events; without a listener the stream's "error" event would crash the process.
    child.stdin.on("error", () => undefined);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk, child));
    child.once("error", (error) => {
      this.failChild(
        child,
        new SemanticAgentError(
          "AGENT_UNAVAILABLE",
          `Guest agent process failed. ${AGENT_UNAVAILABLE_HINT}`,
          { cause: error },
        ),
      );
    });
    child.once("exit", () => {
      this.failChild(
        child,
        new SemanticAgentError(
          "AGENT_UNAVAILABLE",
          `Guest agent process exited before responding. ${AGENT_UNAVAILABLE_HINT}`,
        ),
      );
    });
    return child;
  }

  private receive(chunk: string, child: SemanticChild): void {
    if (this.child !== child) return;
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_RESPONSE_BYTES) {
      this.failProtocol(child, "Semantic agent response exceeds the maximum size");
      return;
    }

    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length === 0) {
        this.failProtocol(child, "Semantic agent returned an empty response");
        return;
      }
      if (!this.handleResponse(line, child)) return;
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleResponse(line: string, child: SemanticChild): boolean {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.failProtocol(child, "Semantic agent returned malformed JSON", error);
      return false;
    }

    const pending = this.pending;
    if (!pending || !isRecord(value) || value.id !== pending.id) {
      this.failProtocol(child, "Semantic agent returned an uncorrelated response");
      return false;
    }

    if (
      value.status === "ok" &&
      hasOnlyKeys(value, ["id", "status", "results"]) &&
      Array.isArray(value.results) &&
      value.results.length === pending.commandCount
    ) {
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(value.results);
      return true;
    }

    if (
      value.status === "error" &&
      hasOnlyKeys(value, ["id", "status", "error"]) &&
      isRecord(value.error) &&
      hasOnlyKeys(value.error, ["code", "message", "commandIndex", "details"])
    ) {
      const { code, message, commandIndex, details } = value.error;
      if (
        typeof code === "string" &&
        GUEST_ERROR_CODES.has(code) &&
        typeof message === "string" &&
        message.length > 0 &&
        Number.isInteger(commandIndex) &&
        (commandIndex as number) >= -1 &&
        (commandIndex as number) < pending.commandCount
      ) {
        const parsedDetails = parseGuestErrorDetails(code, details);
        if (parsedDetails === undefined && details !== undefined) {
          this.failProtocol(child, "Semantic agent returned malformed error details");
          return false;
        }
        this.pending = undefined;
        clearTimeout(pending.timer);
        pending.reject(
          new SemanticAgentError(code, safeGuestMessage(message), {
            commandIndex: commandIndex as number,
            details: parsedDetails,
          }),
        );
        return true;
      }
    }

    this.failProtocol(child, "Semantic agent returned a malformed response");
    return false;
  }

  private failProtocol(child: SemanticChild, message: string, cause?: unknown): void {
    this.rejectPending(new SemanticAgentError("UPSTREAM_ERROR", message, { cause }));
    void this.invalidate(child);
  }

  private failChild(child: SemanticChild, error: SemanticAgentError): void {
    this.stopKeepalive(child);
    if (this.child !== child) return;
    this.child = undefined;
    this.stdoutBuffer = "";
    this.rejectPending(error);
  }

  private rejectPending(error: unknown): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private async invalidate(child: SemanticChild): Promise<void> {
    this.stopKeepalive(child);
    if (this.child === child) this.child = undefined;
    this.stdoutBuffer = "";
    await this.trackTermination(child);
  }

  private trackTermination(child: SemanticChild): Promise<void> {
    const existing = this.terminations.get(child);
    if (existing) return existing;

    const termination = this.terminateChild(child).finally(() => {
      this.terminations.delete(child);
    });
    this.terminations.set(child, termination);
    return termination;
  }

  private async terminateChild(child: SemanticChild): Promise<void> {
    if (child.exitCode !== null) return;

    // prlctl relays stdin to the guest process. Closing it lets the agent observe
    // EOF and exit itself instead of orphaning it by killing only the relay.
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    if (await this.waitForExit(child, CHILD_EXIT_GRACE_MS)) return;

    if (!child.killed && child.exitCode === null) child.kill();
    await this.waitForExit(child, CHILD_KILL_GRACE_MS);
  }

  private waitForExit(child: SemanticChild, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = (): void => {
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve(true);
      };
      child.once("exit", onExit);
      if (child.exitCode !== null) onExit();
    });
  }

  private toGuestCommand(command: SemanticCommand): GuestCommand {
    if (command.type !== "interact") return command as GuestCommand;
    const { type, ...action } = command.action;
    return {
      type: command.type,
      ref: command.ref,
      action: {
        kind: `${type[0]!.toUpperCase()}${type.slice(1)}`,
        ...("value" in action ? { value: action.value } : {}),
      },
    };
  }

  private requestTimeout(commands: readonly SemanticCommand[]): number {
    const waitMs = commands.reduce(
      (total, command) =>
        total + (command.type === "wait" ? (command.timeoutMs ?? 10_000) : 0),
      0,
    );
    return Math.min(BASE_REQUEST_TIMEOUT_MS + waitMs, MAX_REQUEST_TIMEOUT_MS);
  }

  private closedError(): SemanticAgentError {
    return new SemanticAgentError(
      "UPSTREAM_ERROR",
      "Semantic agent connection closed",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function safeGuestMessage(message: string): string {
  const normalized = message.replace(/[\r\n\t]+/g, " ").trim();
  return normalized.slice(0, 1_024) || "Semantic agent operation failed";
}

function parseGuestErrorDetails(
  code: string,
  value: unknown,
): SemanticErrorDetails | undefined {
  if (value === undefined) return undefined;
  if (code !== "AMBIGUOUS_MATCH" || !isRecord(value)) return undefined;
  if (!hasOnlyKeys(value, ["candidates"]) ||
      !Array.isArray(value.candidates) || value.candidates.length < 1 ||
      value.candidates.length > MAX_AMBIGUOUS_CANDIDATES) return undefined;

  const candidates: SemanticCandidateSummary[] = [];
  for (const valueCandidate of value.candidates) {
    if (!isRecord(valueCandidate) || typeof valueCandidate.role !== "string" ||
        valueCandidate.role.length === 0) return undefined;
    const allowed = new Set(["reference", "role", "name", "text", "automationId"]);
    if (Object.keys(valueCandidate).some((key) => !allowed.has(key))) return undefined;
    for (const key of ["reference", "name", "text", "automationId"] as const) {
      if (valueCandidate[key] !== undefined && typeof valueCandidate[key] !== "string") return undefined;
    }
    candidates.push({
      ...(valueCandidate.reference === undefined ? {} : { reference: valueCandidate.reference as string }),
      role: valueCandidate.role,
      ...(valueCandidate.name === undefined ? {} : { name: valueCandidate.name as string }),
      ...(valueCandidate.text === undefined ? {} : { text: valueCandidate.text as string }),
      ...(valueCandidate.automationId === undefined
        ? {}
        : { automationId: valueCandidate.automationId as string }),
    });
  }
  return { candidates };
}

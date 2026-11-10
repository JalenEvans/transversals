import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export type AgentCommand = Record<string, unknown> & { type: string };
export type CommandHandler = (command: AgentCommand) => unknown;

/** Throw from a handler to make the fake agent answer with a protocol error envelope. */
export class AgentFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type SpawnCall = {
  command: string;
  args: readonly string[];
  options: Record<string, unknown> | undefined;
};

export type FakeAgentBehavior =
  /** Answers every NDJSON request through the handlers. */
  | "respond"
  /** spawnProcess throws synchronously (e.g. prlctl missing). */
  | "throw-on-spawn"
  /** The child emits an async spawn 'error' (ENOENT) and never answers. */
  | "error-event"
  /** The relay exits (prlctl exec failed / agent missing) before answering the first request. */
  | "exit-before-response";

export const DEFAULT_HELLO = {
  agentVersion: "0.0.0-test",
  protocolVersion: 1,
  sessionId: 1,
  interactiveSession: true,
  missingNativeFiles: [] as string[],
};

export class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  /** Every raw chunk the host wrote to stdin, in order (C-3 KA-H3). */
  readonly stdinWrites: string[] = [];
  /** `Date.now()` of each blank (keepalive) stdin line; these are never answered. */
  readonly keepalives: number[] = [];
  readonly stdout = new PassThrough();
  readonly stderr = null;
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  private exited = false;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.finish(null, signal);
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    setImmediate(() => {
      this.emit("exit", code, signal);
      this.stdout.end();
      this.emit("close", code, signal);
    });
  }
}

/**
 * In-process stand-in for `prlctl exec <vm> --current-user <agent>` speaking the guest
 * agent NDJSON protocol: request `{id, commands:[...]}` -> `{id, status:"ok", results}` or
 * `{id, status:"error", error:{code, message, commandIndex}}`.
 */
export function createFakeGuestAgent(options: {
  behavior?: FakeAgentBehavior;
  handlers?: Partial<Record<string, CommandHandler>>;
  /**
   * protocolVersion reported by the default hello handler (default: DEFAULT_HELLO's 1, so the host
   * sends no keepalives unless a test opts in). `null` omits the field.
   */
  protocolVersion?: number | null;
  /** Return a raw stdout payload (written verbatim) to replace the normal response to a request. */
  rawResponse?: (request: { id: unknown; commands: AgentCommand[] }) => string | undefined;
} = {}) {
  const behavior = options.behavior ?? "respond";
  const hello = (): Record<string, unknown> => {
    if (options.protocolVersion === undefined) return DEFAULT_HELLO;
    const { protocolVersion: _default, ...rest } = DEFAULT_HELLO;
    return options.protocolVersion === null ? rest : { ...rest, protocolVersion: options.protocolVersion };
  };
  const handlers: Partial<Record<string, CommandHandler>> = {
    hello,
    ...options.handlers,
  };
  const spawnCalls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const requests: Array<{ id: unknown; commands: AgentCommand[] }> = [];

  const spawnProcess = (
    command: string,
    args: readonly string[],
    spawnOptions?: Record<string, unknown>,
  ) => {
    spawnCalls.push({ command, args: [...args], options: spawnOptions });
    if (behavior === "throw-on-spawn") {
      throw Object.assign(new Error("spawn prlctl ENOENT"), { code: "ENOENT" });
    }

    const child = new FakeChild();
    children.push(child);
    let buffer = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("finish", () => child.finish(0));

    if (behavior === "error-event") {
      setImmediate(() =>
        child.emit(
          "error",
          Object.assign(new Error("spawn prlctl ENOENT"), { code: "ENOENT" }),
        ),
      );
    }

    child.stdin.on("data", (chunk: string) => {
      child.stdinWrites.push(chunk);
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.trim().length === 0) {
          child.keepalives.push(Date.now());
          continue;
        }

        const request = JSON.parse(line) as { id: unknown; commands: AgentCommand[] };
        requests.push(request);

        if (behavior === "exit-before-response") {
          child.finish(255);
          return;
        }
        if (behavior !== "respond") return;

        const raw = options.rawResponse?.(request);
        if (raw !== undefined) {
          setImmediate(() => child.stdout.write(raw));
          continue;
        }

        setImmediate(() => {
          const results: unknown[] = [];
          for (const [index, command] of request.commands.entries()) {
            const handler = handlers[command.type];
            try {
              if (!handler) {
                throw new AgentFailure(
                  "CAPABILITY_UNAVAILABLE",
                  `fake agent has no handler for '${command.type}'`,
                );
              }
              results.push(handler(command));
            } catch (error) {
              const failure =
                error instanceof AgentFailure
                  ? error
                  : new AgentFailure("BACKEND_FAILURE", String(error));
              child.stdout.write(
                `${JSON.stringify({
                  id: request.id,
                  status: "error",
                  error: {
                    code: failure.code,
                    message: failure.message,
                    commandIndex: index,
                  },
                })}\n`,
              );
              return;
            }
          }
          child.stdout.write(
            `${JSON.stringify({ id: request.id, status: "ok", results })}\n`,
          );
        });
      }
    });

    return child as never;
  };

  return {
    spawnProcess,
    spawnCalls,
    requests,
    /** Every child spawned so far, oldest first. */
    children,
    commands: (): AgentCommand[] => requests.flatMap((request) => request.commands),
  };
}

import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

// Test doubles for `transversals stream` (C-2). Nothing here touches real processes,
// signals or process.stdout.

export type StreamSpawnCall = {
  command: string;
  args: string[];
  options: Record<string, unknown> | undefined;
};

export type FakeStreamChildOptions = {
  /** Exit (code 0) once the host ends stdin, like the guest agent on EOF. Default true. */
  exitOnStdinEnd?: boolean;
  /** Exit (SIGTERM) when kill() is called. Default true. */
  exitOnKill?: boolean;
  /** Every stdin write fails asynchronously with EPIPE (the relay is gone). Default false. */
  failStdinWrites?: boolean;
};

/** One host write to the relay's stdin (A-HB heartbeat). */
export type StdinWrite = {
  bytes: Buffer;
  /** Date.now() at the write (fake time under vi fake timers). */
  at: number;
  /** True when written after stdin.end() was called. */
  afterEnd: boolean;
  /** True when written after the child exited. */
  afterExit: boolean;
};

/** Stand-in for `prlctl exec <vm> --current-user <agent> stream ...` with a binary stdout. */
export class FakeStreamChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = null;
  readonly stdin: Writable;
  readonly pid = 5151;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  stdinEnded = false;
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  /** Ordered record of host-driven lifecycle actions ("stdin.end", "kill"). */
  readonly actions: string[] = [];
  exited = false;
  /** Every stdin.write call, including ones the stream rejects (write after end). */
  readonly stdinWrites: StdinWrite[] = [];
  /** Date.now() when stdin.end() was first called. */
  stdinEndedAt: number | undefined;
  /** Date.now() at spawn (construction). */
  readonly spawnedAt = Date.now();

  constructor(private readonly options: FakeStreamChildOptions = {}) {
    super();
    const stdin = new Writable({
      write: (_chunk, _encoding, callback) => {
        if (this.options.failStdinWrites) {
          callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write", errno: -32 }));
          return;
        }
        callback();
      },
      final: (callback) => {
        this.stdinEnded = true;
        if (!this.actions.includes("stdin.end")) this.actions.push("stdin.end");
        if (this.options.exitOnStdinEnd ?? true) setImmediate(() => this.exit(0));
        callback();
      },
    });
    const write = stdin.write.bind(stdin) as (...args: unknown[]) => boolean;
    stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
      this.stdinWrites.push({
        bytes: Buffer.from(chunk as Buffer | string),
        at: Date.now(),
        afterEnd: this.stdinEndedAt !== undefined,
        afterExit: this.exited,
      });
      return write(chunk, ...rest);
    }) as typeof stdin.write;
    const end = stdin.end.bind(stdin) as (...args: unknown[]) => Writable;
    stdin.end = ((...args: unknown[]) => {
      this.stdinEndedAt ??= Date.now();
      return end(...args);
    }) as typeof stdin.end;
    this.stdin = stdin;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    this.actions.push("kill");
    if (this.options.exitOnKill ?? true) setImmediate(() => this.exit(null, "SIGTERM"));
    return true;
  }

  /** Pushes raw bytes on the child's stdout (any split the test wants). */
  send(...chunks: Buffer[]): void {
    for (const chunk of chunks) this.stdout.write(chunk);
  }

  /** Simulates the relay ending: emits exit, ends stdout, emits close. Idempotent. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.stdout.end();
    this.emit("close", code, signal);
  }

  /** Async spawn failure (e.g. prlctl missing): emits 'error' and never exits. */
  failToSpawn(): void {
    this.emit(
      "error",
      Object.assign(new Error("spawn prlctl ENOENT"), { code: "ENOENT", syscall: "spawn prlctl" }),
    );
  }
}

/** Spawn fake recording each call; optionally throws synchronously like a missing executable. */
export function createFakeStreamSpawn(
  options: FakeStreamChildOptions & { throwOnSpawn?: boolean } = {},
) {
  const calls: StreamSpawnCall[] = [];
  const children: FakeStreamChild[] = [];
  const spawnProcess = (
    command: string,
    args: readonly string[],
    spawnOptions?: Record<string, unknown>,
  ) => {
    calls.push({ command, args: [...args], options: spawnOptions });
    if (options.throwOnSpawn) {
      throw Object.assign(new Error("spawn prlctl ENOENT"), { code: "ENOENT" });
    }
    const child = new FakeStreamChild(options);
    children.push(child);
    return child;
  };
  return {
    spawnProcess,
    calls,
    children,
    get child(): FakeStreamChild | undefined {
      return children[0];
    },
  };
}

/** Binary sink (`deps.streamOut`): records every write; `write` returns `accept` (default true). */
export class FakeStreamSink extends EventEmitter {
  readonly writes: Buffer[] = [];
  /** Return value of the next write calls; set false to simulate a full pipe. */
  accept = true;

  write(chunk: Buffer | Uint8Array | string): boolean {
    if (typeof chunk === "string") {
      this.writes.push(Buffer.from(chunk, "utf8"));
      this.textWrites.push(chunk);
    } else {
      this.writes.push(Buffer.from(chunk));
    }
    return this.accept;
  }

  /** String writes (must stay empty: the sink only gets JPEG bytes). */
  readonly textWrites: string[] = [];

  bytes(): Buffer {
    return Buffer.concat(this.writes);
  }

  /** The consumer went away (e.g. `| ffplay` closed). */
  breakPipe(): void {
    this.emit(
      "error",
      Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write", errno: -32 }),
    );
  }
}

/** `deps.onSignal` fake: records handlers and unsubscriptions; `raise` delivers a signal. */
export function createFakeSignals() {
  const handlers = new Set<(signal: NodeJS.Signals) => void>();
  let subscribed = 0;
  let unsubscribed = 0;
  const onSignal = (handler: (signal: NodeJS.Signals) => void) => {
    subscribed++;
    handlers.add(handler);
    return () => {
      if (handlers.delete(handler)) unsubscribed++;
    };
  };
  return {
    onSignal,
    raise: (signal: NodeJS.Signals) => {
      for (const handler of [...handlers]) handler(signal);
    },
    active: () => handlers.size,
    subscribed: () => subscribed,
    unsubscribed: () => unsubscribed,
  };
}

/** A fake JPEG of `length` bytes (SOI marker first), distinguishable by `tag`. */
export function jpeg(length: number, tag = 0): Buffer {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 7 + tag * 31) & 0xff;
  if (length >= 2) {
    bytes[0] = 0xff;
    bytes[1] = 0xd8;
  }
  return bytes;
}

/** 4-byte big-endian length prefix + payload, as the guest writes it. */
export function frame(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export function header(length: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(length, 0);
  return bytes;
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as cli from "../src/cli.js";
import {
  createFakeSignals,
  createFakeStreamSpawn,
  FakeStreamSink,
  frame,
  header,
  jpeg,
  type FakeStreamChildOptions,
} from "./helpers/fake-stream-child.js";

// C-2 (host): `transversals stream` relays the guest's length-prefixed JPEG frames to a binary
// sink as concatenated JPEG bytes (MJPEG for e.g. `| ffplay -f mjpeg -`).
//
// Assumed contracts (see report):
//   src/stream.ts:
//     export class FrameDecoder { constructor(maxFrameBytes = 2_097_152); push(chunk: Buffer): Buffer[] }
//   src/cli.ts: `runCli(["stream", ...flags], deps)` does the work (no runStream export is tested).
//   CliDeps additions:
//     spawnProcess  - existing dep, its stdio type widened to ["pipe","pipe","ignore"|"inherit"]
//     streamOut     - { write(chunk: Buffer): boolean; once/on/off("drain"|"error", listener) }
//     onSignal      - (handler: (signal: "SIGINT"|"SIGTERM") => void) => () => void   // returns unsubscribe
//   Timers are plain setTimeout/clearTimeout (driven by vi fake timers here).

const VM_ID = "6d0c4a3e-91b7-4f25-8c3e-2a7b5e9f1d40";
const OTHER_VM_ID = "9c1e7a54-0d3f-4b8e-a2c6-5f4e3d2c1b0a";
const VM_NAME = "Windows 11 (Clean)";
const OTHER_VM_NAME = "Windows 11 (Dev)";
const HOME = "/Users/tester";
const PACKAGE_ROOT = "/usr/local/lib/transversals";
const CONFIG_PATH = `${HOME}/Library/Application Support/transversals/config.json`;
const AGENT =
  "C:\\Users\\tester\\AppData\\Local\\transversals\\agent\\Transversals.GuestAgent.exe";
const OTHER_AGENT = "C:\\override\\Transversals.GuestAgent.exe";
const MAX_FRAME_BYTES = 2_097_152;

type VmEntry = { uuid: string; name: string; status: string };
type RunCommand = (
  executable: string,
  args: readonly string[],
  options?: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

const runCli = (cli as unknown as {
  runCli: (argv: string[], deps: Record<string, unknown>) => Promise<number>;
}).runCli;

async function loadDecoder(): Promise<new (maxFrameBytes?: number) => { push(chunk: Buffer): Buffer[] }> {
  const module = (await import("../src/stream.js")) as Record<string, unknown>;
  expect(module.FrameDecoder, "src/stream.ts must export class FrameDecoder").toBeTypeOf("function");
  return module.FrameDecoder as new (maxFrameBytes?: number) => { push(chunk: Buffer): Buffer[] };
}

function configFile(config: Record<string, string>): Record<string, string> {
  return { [CONFIG_PATH]: `${JSON.stringify(config, null, 2)}\n` };
}

const COMPLETE_CONFIG = { vmId: VM_ID, agentExecutable: AGENT };
const RUNNING_VMS: VmEntry[] = [
  { uuid: VM_ID, name: VM_NAME, status: "running" },
  { uuid: OTHER_VM_ID, name: OTHER_VM_NAME, status: "running" },
];

/** Real setImmediate (not faked): lets streams, promises and the fake child's async exits run. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

function harness(
  options: {
    files?: Record<string, string>;
    env?: NodeJS.ProcessEnv;
    vms?: VmEntry[];
    listFails?: boolean;
    child?: FakeStreamChildOptions;
    throwOnSpawn?: boolean;
  } = {},
) {
  const files = new Map<string, string>(
    Object.entries({
      [`${PACKAGE_ROOT}/package.json`]: JSON.stringify({ name: "transversals-mcp", version: "0.0.0" }),
      ...(options.files ?? configFile(COMPLETE_CONFIG)),
    }),
  );
  const vms = options.vms ?? RUNNING_VMS;
  const runCommand = vi.fn<RunCommand>(async (_executable, args) => {
    if (args[0] === "list") {
      if (options.listFails) {
        throw Object.assign(new Error("Command failed: prlctl list -a -j"), {
          stderr: "Failed to connect to Parallels Service.",
        });
      }
      return {
        stdout: `${JSON.stringify(
          vms.map(({ uuid, name, status }) => ({ uuid: `{${uuid}}`, status, ip_configured: "-", name })),
        )}\n`,
        stderr: "",
      };
    }
    if (args[0] === "status") {
      const vm = vms.find(({ uuid }) => uuid === args[1]);
      return { stdout: `VM {${args[1]}} exist ${vm?.status ?? "stopped"}\n`, stderr: "" };
    }
    throw new Error(`unexpected prlctl call in stream test: ${args.join(" ")}`);
  });
  const spawn = createFakeStreamSpawn({ ...options.child, throwOnSpawn: options.throwOnSpawn });
  const sink = new FakeStreamSink();
  const signals = createFakeSignals();
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    runCommand,
    spawnProcess: spawn.spawnProcess,
    streamOut: sink,
    onSignal: signals.onSignal,
    env: options.env ?? {},
    homedir: HOME,
    packageRoot: PACKAGE_ROOT,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
          code: "ENOENT",
        });
      }
      return content;
    }),
    writeFile: vi.fn(async () => {
      throw new Error("stream must not write files");
    }),
    mkdir: vi.fn(async () => undefined),
    startServer: vi.fn(async () => {
      throw new Error("stream must not start the MCP server");
    }),
    serveCommand: ["/usr/local/bin/transversals", "serve"],
    prompt: vi.fn(async () => ""),
    removePath: vi.fn(async () => {
      throw new Error("stream must not remove files");
    }),
  };

  let code: number | undefined;
  let failure: unknown;
  let started: Promise<number> | undefined;

  return {
    deps,
    spawn,
    sink,
    signals,
    runCommand,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    code: () => code,
    failure: () => failure,
    /** Starts `transversals stream ...` without awaiting it. */
    start(...flags: string[]): Promise<number> {
      started = runCli(["stream", ...flags], deps);
      started.then(
        (value) => {
          code = value;
        },
        (error: unknown) => {
          failure = error;
        },
      );
      return started;
    },
    /** Runs to completion (for paths that never reach a long-lived stream). */
    async run(...flags: string[]): Promise<number> {
      const promise = this.start(...flags);
      for (let i = 0; i < 200 && code === undefined && failure === undefined; i++) await tick();
      return promise;
    },
    /** Starts the stream and waits until the relay has been spawned. */
    async open(...flags: string[]) {
      this.start(...flags);
      for (let i = 0; i < 200 && spawn.children.length === 0 && code === undefined; i++) await tick();
      if (spawn.children.length === 0) {
        throw new Error(
          `stream did not spawn the relay (exit ${String(code)}, failure ${String(failure)}); stderr: ${err.join("")}`,
        );
      }
      await settle();
      return spawn.children[0]!;
    },
    async finished(rounds = 200): Promise<number | undefined> {
      for (let i = 0; i < rounds && code === undefined && failure === undefined; i++) await tick();
      if (failure !== undefined) throw failure;
      return code;
    },
  };
}

type Harness = ReturnType<typeof harness>;

/** Sends chunks on the child's stdout and lets them flow through the decoder. */
async function send(h: Harness, ...chunks: Buffer[]): Promise<void> {
  h.spawn.child!.send(...chunks);
  await settle();
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

/** Ends a healthy stream through SIGINT so no test leaves a pending command behind. */
async function stopWithSigint(h: Harness): Promise<number | undefined> {
  h.signals.raise("SIGINT");
  await settle();
  await advance(2_000);
  return h.finished();
}

beforeEach(() => {
  // Only timer-based APIs are faked; setImmediate/nextTick stay real so streams keep flowing.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// H4 FrameDecoder (pure)

describe("H4 FrameDecoder", () => {
  it("decodes a single frame delivered in one chunk", async () => {
    const FrameDecoder = await loadDecoder();
    const payload = jpeg(300, 1);

    expect(new FrameDecoder().push(frame(payload))).toEqual([payload]);
  });

  it("decodes several frames delivered in one chunk, in order", async () => {
    const FrameDecoder = await loadDecoder();
    const payloads = [jpeg(10, 1), jpeg(1, 2), jpeg(70_000, 3)];

    expect(new FrameDecoder().push(Buffer.concat(payloads.map(frame)))).toEqual(payloads);
  });

  it("returns nothing until a frame is complete, then the frame", async () => {
    const FrameDecoder = await loadDecoder();
    const payload = jpeg(50, 4);
    const raw = frame(payload);
    const decoder = new FrameDecoder();

    expect(decoder.push(raw.subarray(0, 2))).toEqual([]);
    expect(decoder.push(raw.subarray(2, 4))).toEqual([]);
    expect(decoder.push(raw.subarray(4, 30))).toEqual([]);
    expect(decoder.push(raw.subarray(30))).toEqual([payload]);
  });

  it("decodes two frames split at every possible offset, including inside each header", async () => {
    const FrameDecoder = await loadDecoder();
    const payloads = [jpeg(9, 5), jpeg(6, 6)];
    const raw = Buffer.concat(payloads.map(frame));

    for (let split = 0; split <= raw.length; split++) {
      const decoder = new FrameDecoder();
      const decoded = [...decoder.push(raw.subarray(0, split)), ...decoder.push(raw.subarray(split))];
      expect(decoded, `split at ${split}`).toEqual(payloads);
    }
  });

  it("decodes a stream delivered one byte at a time", async () => {
    const FrameDecoder = await loadDecoder();
    const payloads = [jpeg(7, 7), jpeg(3, 8), jpeg(12, 9)];
    const raw = Buffer.concat(payloads.map(frame));
    const decoder = new FrameDecoder();
    const decoded: Buffer[] = [];

    for (let i = 0; i < raw.length; i++) decoded.push(...decoder.push(raw.subarray(i, i + 1)));

    expect(decoded).toEqual(payloads);
  });

  it("returns frames that stay intact after later chunks arrive", async () => {
    const FrameDecoder = await loadDecoder();
    const first = jpeg(20, 10);
    const decoder = new FrameDecoder();
    const [decoded] = decoder.push(frame(first));
    const snapshot = Buffer.from(decoded!);

    decoder.push(Buffer.concat([frame(jpeg(20, 11)), header(500), jpeg(100, 12)]));

    expect(decoded).toEqual(snapshot);
  });

  it("throws on a zero-length frame", async () => {
    const FrameDecoder = await loadDecoder();

    expect(() => new FrameDecoder().push(header(0))).toThrow(Error);
  });

  it("throws on a zero-length frame that follows a valid one", async () => {
    const FrameDecoder = await loadDecoder();
    const decoder = new FrameDecoder();

    expect(decoder.push(frame(jpeg(5)))).toHaveLength(1);
    expect(() => decoder.push(header(0))).toThrow(Error);
  });

  it("accepts a frame exactly at the cap and throws as soon as a header exceeds it", async () => {
    const FrameDecoder = await loadDecoder();
    const atCap = jpeg(100, 13);

    expect(new FrameDecoder(100).push(frame(atCap))).toEqual([atCap]);
    // The oversize header alone must throw: the decoder must not wait for (or buffer) the payload.
    expect(() => new FrameDecoder(100).push(header(101))).toThrow(Error);
  });

  it("defaults the cap to 2 MiB", async () => {
    const FrameDecoder = await loadDecoder();

    expect(new FrameDecoder().push(header(MAX_FRAME_BYTES))).toEqual([]);
    expect(() => new FrameDecoder().push(header(MAX_FRAME_BYTES + 1))).toThrow(Error);
    expect(() => new FrameDecoder().push(Buffer.from([0xff, 0xff, 0xff, 0xff]))).toThrow(Error);
  });
});

// ---------------------------------------------------------------------------
// H1 spawn argv, defaults, flag passthrough and --help

describe("H1 `transversals stream` spawns the guest stream relay", () => {
  it("spawns prlctl exec <vm> --current-user <agent> stream with the default flags, no shell, stderr inherited", async () => {
    const h = harness();

    await h.open();

    expect(h.spawn.calls).toHaveLength(1);
    const [call] = h.spawn.calls;
    expect(call!.command).toBe("prlctl");
    expect(call!.args).toEqual([
      "exec",
      VM_ID,
      "--current-user",
      AGENT,
      "stream",
      "--fps",
      "15",
      "--max-long-edge",
      "800",
      "--quality",
      "70",
    ]);
    expect(call!.options?.shell ?? false).toBe(false);
    expect(call!.options?.stdio).toEqual(["pipe", "pipe", "inherit"]);

    expect(await stopWithSigint(h)).toBe(0);
  });

  it.each([
    [["--fps", "1", "--max-size", "320", "--quality", "30"], ["1", "320", "30"]],
    [["--fps", "30", "--max-size", "1920", "--quality", "95"], ["30", "1920", "95"]],
    [["--quality", "55", "--fps", "8"], ["8", "800", "55"]],
    [["--max-size", "1024"], ["15", "1024", "70"]],
  ])("passes %j through as --fps/--max-long-edge/--quality", async (flags, [fps, edge, quality]) => {
    const h = harness();

    await h.open(...flags);

    expect(h.spawn.calls[0]!.args.slice(4)).toEqual([
      "stream",
      "--fps",
      fps,
      "--max-long-edge",
      edge,
      "--quality",
      quality,
    ]);
    expect(await stopWithSigint(h)).toBe(0);
  });

  it("lists `stream` and its flags in --help", async () => {
    const help = harness();
    const code = await runCli(["--help"], help.deps);

    expect(code).toBe(0);
    expect(help.stdout()).toMatch(/^\s+stream\b/m);
    for (const flag of ["--fps", "--max-size", "--quality"]) expect(help.stdout()).toContain(flag);
  });
});

// ---------------------------------------------------------------------------
// H2 invalid flags

describe("H2 invalid stream flags exit 2 without spawning", () => {
  it.each([
    [["--fps", "0"], "--fps"],
    [["--fps", "31"], "--fps"],
    [["--fps", "abc"], "--fps"],
    [["--fps", "1.5"], "--fps"],
    [["--fps", ""], "--fps"],
    [["--fps", "-5"], "--fps"],
    [["--fps"], "--fps"],
    [["--fps", "--quality", "50"], "--fps"],
    [["--max-size", "319"], "--max-size"],
    [["--max-size", "1921"], "--max-size"],
    [["--quality", "29"], "--quality"],
    [["--quality", "96"], "--quality"],
    [["--fps", "5", "--fps", "6"], "--fps"],
    [["--vm"], "--vm"],
    [["--vm", VM_NAME, "--vm", OTHER_VM_NAME], "--vm"],
    [["--max-long-edge", "800"], "--max-long-edge"],
    [["--bogus"], "--bogus"],
    [["extra"], "extra"],
  ])("%j", async (flags, culprit) => {
    const h = harness();

    const code = await h.run(...flags);

    expect(code).toBe(2);
    expect(h.stderr()).not.toContain('Unknown command "stream"');
    expect(h.stderr()).toContain(culprit);
    expect(h.spawn.calls).toHaveLength(0);
    expect(h.sink.writes).toHaveLength(0);
    expect(h.stdout()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// H3 config, env and --vm resolution

describe("H3 VM and agent resolution", () => {
  it("fails with exit 1 and a setup hint when not configured", async () => {
    const h = harness({ files: {} });

    expect(await h.run()).toBe(1);
    expect(h.stderr()).toContain("transversals setup");
    expect(h.spawn.calls).toHaveLength(0);
  });

  it("uses TRANSVERSALS_VM_ID / TRANSVERSALS_UI_AGENT_EXECUTABLE without a config file", async () => {
    const h = harness({
      files: {},
      env: { TRANSVERSALS_VM_ID: OTHER_VM_ID, TRANSVERSALS_UI_AGENT_EXECUTABLE: OTHER_AGENT },
    });

    await h.open();

    expect(h.spawn.calls[0]!.args.slice(0, 4)).toEqual(["exec", OTHER_VM_ID, "--current-user", OTHER_AGENT]);
    expect(await stopWithSigint(h)).toBe(0);
  });

  it("lets env override the config file", async () => {
    const h = harness({ env: { TRANSVERSALS_VM_ID: OTHER_VM_ID } });

    await h.open();

    expect(h.spawn.calls[0]!.args.slice(0, 4)).toEqual(["exec", OTHER_VM_ID, "--current-user", AGENT]);
    expect(await stopWithSigint(h)).toBe(0);
  });

  it.each([
    ["name", OTHER_VM_NAME],
    ["uuid", OTHER_VM_ID],
    ["braced uppercase uuid", `{${OTHER_VM_ID.toUpperCase()}}`],
  ])("--vm <%s> overrides the configured VM", async (_kind, selector) => {
    const h = harness();

    await h.open("--vm", selector);

    expect(h.spawn.calls[0]!.args.slice(0, 4)).toEqual(["exec", OTHER_VM_ID, "--current-user", AGENT]);
    expect(await stopWithSigint(h)).toBe(0);
  });

  it("fails with exit 1 when --vm matches no VM", async () => {
    const h = harness();

    expect(await h.run("--vm", "No Such VM")).toBe(1);
    expect(h.stderr()).toContain("No Such VM");
    expect(h.spawn.calls).toHaveLength(0);
  });

  it("fails with exit 1 when the configured VM no longer exists", async () => {
    const h = harness({ vms: [{ uuid: OTHER_VM_ID, name: OTHER_VM_NAME, status: "running" }] });

    expect(await h.run()).toBe(1);
    expect(h.stderr()).not.toBe("");
    expect(h.spawn.calls).toHaveLength(0);
  });

  it.each([
    ["configured VM", [] as string[]],
    ["--vm", ["--vm", VM_NAME]],
  ])("fails with exit 1 when the %s is not running", async (_kind, flags) => {
    const h = harness({
      vms: [
        { uuid: VM_ID, name: VM_NAME, status: "stopped" },
        { uuid: OTHER_VM_ID, name: OTHER_VM_NAME, status: "running" },
      ],
    });

    expect(await h.run(...flags)).toBe(1);
    expect(h.stderr()).toContain("stopped");
    expect(h.spawn.calls).toHaveLength(0);
  });

  it("fails with exit 1 when Parallels cannot list VMs", async () => {
    const h = harness({ listFails: true });

    expect(await h.run()).toBe(1);
    expect(h.stderr()).not.toBe("");
    expect(h.spawn.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// H5 sink output

describe("H5 the sink receives only concatenated JPEG bytes", () => {
  it("writes each decoded frame's JPEG bytes with no length prefixes", async () => {
    const h = harness();
    const payloads = [jpeg(40, 1), jpeg(25, 2), jpeg(60, 3)];
    await h.open();

    await send(h, Buffer.concat(payloads.map(frame)));

    expect(h.sink.bytes()).toEqual(Buffer.concat(payloads));
    expect(await stopWithSigint(h)).toBe(0);
  });

  it("reassembles frames split across arbitrary chunks before writing them", async () => {
    const h = harness();
    const payloads = [jpeg(30, 4), jpeg(17, 5)];
    const raw = Buffer.concat(payloads.map(frame));
    await h.open();

    await send(h, raw.subarray(0, 2));
    expect(h.sink.writes).toHaveLength(0);
    await send(h, raw.subarray(2, 20), raw.subarray(20, 37));
    expect(h.sink.bytes()).toEqual(payloads[0]);
    await send(h, raw.subarray(37));

    expect(h.sink.bytes()).toEqual(Buffer.concat(payloads));
    expect(await stopWithSigint(h)).toBe(0);
  });

  it("never writes text to the sink or to text stdout", async () => {
    const h = harness();
    await h.open();

    await send(h, frame(jpeg(10, 6)));
    await advance(11_000); // includes a watchdog trip, whose message must go to stderr only
    await h.finished();

    expect(h.sink.textWrites).toEqual([]);
    expect(h.sink.bytes()).toEqual(jpeg(10, 6));
    expect(h.stdout()).toBe("");
    expect(h.stderr()).not.toBe("");
  });
});

// ---------------------------------------------------------------------------
// H6 watchdog

describe("H6 frame watchdog", () => {
  it("trips 10 s after spawn when no frame arrives, hinting at `transversals setup`", async () => {
    const h = harness();
    const child = await h.open();

    await advance(9_999);
    expect(h.code()).toBeUndefined();
    expect(child.stdinEnded).toBe(false);

    await advance(1);
    expect(child.stdinEnded).toBe(true);
    expect(await h.finished()).toBe(1);
    expect(h.stderr()).toContain("transversals setup");
  });

  it("allows 5 s after each complete frame", async () => {
    const h = harness();
    const child = await h.open();

    await advance(9_000);
    await send(h, frame(jpeg(5, 1)));
    await advance(4_999); // 13_999 ms: past the first-frame window, inside the per-frame window
    expect(h.code()).toBeUndefined();
    expect(child.stdinEnded).toBe(false);

    await advance(1);
    expect(await h.finished()).toBe(1);
    expect(h.stderr()).toContain("transversals setup");
  });

  it("keeps a steady stream alive indefinitely", async () => {
    const h = harness();
    const child = await h.open();

    for (let i = 0; i < 10; i++) {
      await advance(4_900);
      await send(h, frame(jpeg(5, i)));
    }

    expect(h.code()).toBeUndefined();
    expect(child.stdinEnded).toBe(false);
    expect(h.sink.writes.length).toBeGreaterThanOrEqual(10);
    expect(await stopWithSigint(h)).toBe(0);
  });

  it("does not let partial frame bytes reset the per-frame window", async () => {
    const h = harness();
    await h.open();

    await advance(1_000);
    await send(h, frame(jpeg(5, 1)));
    await advance(4_500);
    await send(h, header(100), jpeg(50, 2)); // half a frame at 5_500 ms
    await advance(499);
    expect(h.code()).toBeUndefined();

    await advance(1); // 5 s after the last complete frame
    expect(await h.finished()).toBe(1);
    expect(h.stderr()).toContain("transversals setup");
  });

  it("does not let partial bytes satisfy the first-frame window", async () => {
    const h = harness();
    await h.open();

    await advance(9_000);
    await send(h, header(100), jpeg(99, 1));
    await advance(1_000);

    expect(await h.finished()).toBe(1);
    expect(h.sink.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// H7 relay exit / error / spawn failure

describe("H7 the relay ending or failing exits 1 promptly", () => {
  it("exits 1 when the relay exits before any frame, without waiting for the watchdog", async () => {
    const h = harness();
    const child = await h.open();

    child.exit(255);

    expect(await h.finished()).toBe(1);
    expect(h.stderr()).not.toBe("");
    expect(h.sink.writes).toHaveLength(0);
  });

  it("exits 1 when the relay exits cleanly between frames", async () => {
    const h = harness();
    const child = await h.open();
    await send(h, frame(jpeg(8, 1)));

    child.exit(0);

    expect(await h.finished()).toBe(1);
    expect(h.sink.bytes()).toEqual(jpeg(8, 1));
  });

  it("discards a partial frame buffered when the relay exits", async () => {
    const h = harness();
    const child = await h.open();
    await send(h, frame(jpeg(8, 1)), header(40), jpeg(40, 2).subarray(0, 39));

    child.exit(1);

    expect(await h.finished()).toBe(1);
    expect(h.sink.bytes()).toEqual(jpeg(8, 1));
  });

  it("exits 1 on an async spawn error (ENOENT) well before the watchdog", async () => {
    const h = harness();
    const child = await h.open();

    child.failToSpawn();
    await settle();
    await advance(2_000); // at most the stdin.end -> kill grace, never the 10 s watchdog

    expect(await h.finished()).toBe(1);
    expect(h.stderr()).not.toBe("");
  });

  it("exits 1 when spawning throws synchronously", async () => {
    const h = harness({ throwOnSpawn: true });

    expect(await h.run()).toBe(1);
    expect(h.spawn.calls).toHaveLength(1);
    expect(h.stderr()).not.toBe("");
    expect(h.signals.active()).toBe(0);
  });

  it("removes its signal listener after the relay exits", async () => {
    const h = harness();
    const child = await h.open();
    expect(h.signals.active()).toBe(1);

    child.exit(1);
    await h.finished();

    expect(h.signals.active()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// H8 decoder errors

describe("H8 malformed relay output ends the relay and exits 1", () => {
  it.each([
    ["an oversize frame header", header(MAX_FRAME_BYTES + 1)],
    ["a zero-length frame header", header(0)],
  ])("on %s", async (_kind, bad) => {
    const h = harness();
    const child = await h.open();
    await send(h, frame(jpeg(12, 1)));

    await send(h, bad);
    await advance(2_000);

    expect(child.stdinEnded).toBe(true);
    expect(await h.finished()).toBe(1);
    expect(h.stderr()).not.toBe("");
    expect(h.sink.bytes()).toEqual(jpeg(12, 1));
    expect(h.signals.active()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// H9 consumer gone (sink EPIPE) and the child shutdown sequence

describe("H9 a broken sink pipe stops cleanly with exit 0", () => {
  it("ends the relay's stdin and exits 0 once the relay exits", async () => {
    const h = harness();
    const child = await h.open();
    await send(h, frame(jpeg(10, 1)));

    h.sink.breakPipe();
    await settle();

    expect(child.stdinEnded).toBe(true);
    expect(await h.finished()).toBe(0);
    expect(child.killed).toBe(false);
  });

  it("stops writing frames once the pipe is broken", async () => {
    const h = harness({ child: { exitOnStdinEnd: false } });
    const child = await h.open();
    await send(h, frame(jpeg(10, 1)));
    h.sink.breakPipe();
    await settle();

    await send(h, frame(jpeg(10, 2)));

    expect(h.sink.bytes()).toEqual(jpeg(10, 1));
    await advance(2_000);
    expect(await h.finished()).toBe(0);
    expect(child.killed).toBe(true);
  });

  it("waits for the relay to exit, killing it only after a 2 s grace period", async () => {
    const h = harness({ child: { exitOnStdinEnd: false } });
    const child = await h.open();

    h.sink.breakPipe();
    await settle();
    expect(child.stdinEnded).toBe(true);

    await advance(1_999);
    expect(child.killed).toBe(false);
    expect(h.code()).toBeUndefined(); // must not resolve while the relay is still running

    await advance(1);
    expect(child.killed).toBe(true);
    expect(child.actions).toEqual(["stdin.end", "kill"]);
    expect(await h.finished()).toBe(0);
  });

  it("resolves after kill even when the relay never reports an exit", async () => {
    const h = harness({ child: { exitOnStdinEnd: false, exitOnKill: false } });
    const child = await h.open();

    h.sink.breakPipe();
    await advance(2_000);
    await advance(1_000);

    expect(child.killed).toBe(true);
    expect(await h.finished()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// H10 signals

describe("H10 SIGINT/SIGTERM stop cleanly with exit 0", () => {
  it.each(["SIGINT", "SIGTERM"] as const)("on %s", async (signal) => {
    const h = harness();
    const child = await h.open();
    expect(h.signals.subscribed()).toBe(1);
    expect(h.signals.active()).toBe(1);
    await send(h, frame(jpeg(10, 1)));

    h.signals.raise(signal);
    await settle();

    expect(child.stdinEnded).toBe(true);
    expect(await h.finished()).toBe(0);
    expect(child.killed).toBe(false);
    expect(h.signals.active()).toBe(0);
    expect(h.sink.bytes()).toEqual(jpeg(10, 1));
  });

  it("kills a relay that ignores stdin EOF after 2 s, then exits 0", async () => {
    const h = harness({ child: { exitOnStdinEnd: false } });
    const child = await h.open();

    h.signals.raise("SIGTERM");
    await advance(1_999);
    expect(h.code()).toBeUndefined();

    await advance(1);
    expect(child.actions).toEqual(["stdin.end", "kill"]);
    expect(await h.finished()).toBe(0);
    expect(h.signals.active()).toBe(0);
  });

  it("removes its signal listener after a watchdog trip", async () => {
    const h = harness();
    await h.open();

    await advance(10_000);
    expect(await h.finished()).toBe(1);

    expect(h.signals.active()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// H11 backpressure

describe("H11 backpressure drops frames until the sink drains", () => {
  it("drops decoded frames while the sink is full and resumes after 'drain'", async () => {
    const h = harness();
    const [first, second, third, fourth] = [jpeg(10, 1), jpeg(11, 2), jpeg(12, 3), jpeg(13, 4)];
    await h.open();

    h.sink.accept = false;
    await send(h, frame(first!)); // written; the sink reports it is full
    await send(h, frame(second!), frame(third!)); // dropped
    expect(h.sink.bytes()).toEqual(first);

    h.sink.accept = true;
    h.sink.emit("drain");
    await settle();
    await send(h, frame(fourth!));

    expect(h.sink.bytes()).toEqual(Buffer.concat([first!, fourth!]));
    expect(await stopWithSigint(h)).toBe(0);
  });

  it("never writes a partial JPEG when frames are dropped", async () => {
    const h = harness();
    const payloads = [jpeg(20, 1), jpeg(21, 2), jpeg(22, 3)];
    await h.open();

    h.sink.accept = false;
    await send(h, Buffer.concat(payloads.map(frame)));

    expect(h.sink.writes.map((chunk) => chunk.length).reduce((a, b) => a + b, 0)).toBe(20);
    expect(h.sink.bytes()).toEqual(payloads[0]);
    expect(await stopWithSigint(h)).toBe(0);
  });

  it("counts dropped frames as liveness: a slow consumer does not trip the watchdog", async () => {
    const h = harness();
    const child = await h.open();

    h.sink.accept = false;
    for (let i = 0; i < 6; i++) {
      await advance(4_000);
      await send(h, frame(jpeg(5, i)));
    }

    expect(h.code()).toBeUndefined();
    expect(child.stdinEnded).toBe(false);
    expect(await stopWithSigint(h)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HB-H stdin heartbeat (A-HB): one 0x0A byte to the relay's stdin every HEARTBEAT_INTERVAL_MS so the
// guest can tell the host is still there even when prlctl dies without closing the guest's stdin.

const HEARTBEAT = Buffer.from([0x0a]);

async function heartbeatInterval(): Promise<unknown> {
  const module = (await import("../src/stream.js")) as Record<string, unknown>;
  return module.HEARTBEAT_INTERVAL_MS;
}

/** Heartbeat write times relative to spawn. */
function beatTimes(child: { stdinWrites: Array<{ at: number }>; spawnedAt: number }): number[] {
  return child.stdinWrites.map((write) => write.at - child.spawnedAt);
}

describe("HB-H1 the host writes a heartbeat byte to the relay's stdin every second", () => {
  it("exports HEARTBEAT_INTERVAL_MS = 1000 from src/stream.ts", async () => {
    expect(await heartbeatInterval()).toBe(1_000);
  });

  it("writes a single 0x0A at 1 s, 2 s and 3 s after spawn", async () => {
    const h = harness();
    const child = await h.open();

    await advance(999);
    expect(child.stdinWrites).toHaveLength(0);

    await advance(1);
    expect(beatTimes(child)).toEqual([1_000]);
    await advance(1_000);
    await advance(1_000);

    expect(beatTimes(child)).toEqual([1_000, 2_000, 3_000]);
    for (const write of child.stdinWrites) expect(write.bytes).toEqual(HEARTBEAT);
    expect(await stopWithSigint(h)).toBe(0);
  });

  it("keeps beating while frames flow", async () => {
    const h = harness();
    const child = await h.open();

    for (let i = 0; i < 6; i++) {
      await advance(1_000);
      await send(h, frame(jpeg(5, i)));
    }

    expect(beatTimes(child)).toEqual([1_000, 2_000, 3_000, 4_000, 5_000, 6_000]);
    expect(await stopWithSigint(h)).toBe(0);
  });
});

describe("HB-H2 the heartbeat stops on every stop path, before stdin.end()", () => {
  type Stop = (h: Harness) => Promise<void>;
  const paths: Array<[string, Stop, { endsStdin: boolean }]> = [
    ["SIGINT", async (h) => h.signals.raise("SIGINT"), { endsStdin: true }],
    ["SIGTERM", async (h) => h.signals.raise("SIGTERM"), { endsStdin: true }],
    ["sink EPIPE", async (h) => h.sink.breakPipe(), { endsStdin: true }],
    ["decoder error", async (h) => h.spawn.child!.send(header(0)), { endsStdin: true }],
    ["watchdog trip", async () => advance(10_000 - 2_500), { endsStdin: true }],
    ["relay exit", async (h) => h.spawn.child!.exit(1), { endsStdin: false }],
  ];

  it.each(paths)("after %s", async (_name, stop, { endsStdin }) => {
    // The relay ignores stdin EOF, so the 2 s kill grace is a window in which a leaked heartbeat would show.
    const h = harness({ child: { exitOnStdinEnd: false } });
    const child = await h.open();
    await advance(2_500);
    expect(child.stdinWrites.length).toBeGreaterThanOrEqual(2);

    await stop(h);
    await settle();
    const stoppedAt = Date.now() - child.spawnedAt;
    const beatsAtStop = child.stdinWrites.length;
    await advance(2_000); // the kill grace
    await advance(5_000);

    expect(child.stdinWrites).toHaveLength(beatsAtStop);
    expect(beatTimes(child).every((at) => at <= stoppedAt)).toBe(true);
    expect(child.stdinWrites.some((write) => write.afterEnd)).toBe(false);
    expect(child.stdinWrites.some((write) => write.afterExit)).toBe(false);
    if (endsStdin) expect(child.stdinEndedAt).toBeDefined();
    expect(await h.finished()).toBeTypeOf("number");
  });
});

describe("HB-H3 a failing heartbeat write is ignored", () => {
  it("keeps streaming and still exits 0 on SIGINT", async () => {
    const h = harness({ child: { failStdinWrites: true } });
    const child = await h.open();

    for (let i = 0; i < 3; i++) {
      await advance(1_000);
      await send(h, frame(jpeg(5, i)));
    }

    expect(child.stdinWrites.length).toBeGreaterThanOrEqual(1);
    expect(h.code()).toBeUndefined();
    expect(h.sink.bytes()).toEqual(Buffer.concat([jpeg(5, 0), jpeg(5, 1), jpeg(5, 2)]));
    expect(await stopWithSigint(h)).toBe(0);
  });

  it("does not change the watchdog's exit code", async () => {
    const h = harness({ child: { failStdinWrites: true } });
    const child = await h.open();

    await advance(10_000);
    await advance(2_000);

    expect(child.stdinWrites.length).toBeGreaterThanOrEqual(1);
    expect(await h.finished()).toBe(1);
    expect(h.stderr()).toContain("transversals setup");
  });
});

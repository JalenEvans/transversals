import type { SpawnImplementation } from "./semantic-agent-client.js";

/** Largest frame the guest may send; matches the guest's StreamLimits.MaxFrameBytes. */
export const MAX_FRAME_BYTES = 2_097_152;
/** No complete frame within this long after spawn means the relay never started streaming. */
export const FIRST_FRAME_TIMEOUT_MS = 10_000;
/** Once streaming, a gap longer than this between complete frames means the relay stalled. */
export const FRAME_GAP_TIMEOUT_MS = 5_000;
/** How long the relay gets to exit after its stdin is closed before it is killed. */
export const KILL_GRACE_MS = 2_000;
/**
 * How often one 0x0A byte goes to the relay's stdin. The guest exits when stdin stays silent for its
 * heartbeat timeout (5 s), because a killed prlctl neither closes the guest's stdin nor fails its writes.
 */
export const HEARTBEAT_INTERVAL_MS = 1_000;
const HEARTBEAT = Buffer.from([0x0a]);

const HEADER_BYTES = 4;

/**
 * Splits the guest's stream (4-byte big-endian length + JPEG bytes, repeated) into JPEG frames.
 * Chunks may split a frame, or its header, anywhere.
 */
export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = MAX_FRAME_BYTES) {}

  /** Returns every frame completed by `chunk`, in order. Throws on a zero or oversize length. */
  push(chunk: Buffer): Buffer[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const frames: Buffer[] = [];
    let offset = 0;
    while (this.pending.length - offset >= HEADER_BYTES) {
      const length = this.pending.readUInt32BE(offset);
      // Checked on the header alone, so an oversize frame is never buffered.
      if (length === 0 || length > this.maxFrameBytes) {
        this.pending = Buffer.alloc(0);
        throw new Error(
          `invalid frame length ${length} (expected 1 to ${this.maxFrameBytes} bytes)`,
        );
      }
      const end = offset + HEADER_BYTES + length;
      if (this.pending.length < end) break;
      // Copy so returned frames never alias a buffer that later chunks reuse.
      frames.push(Buffer.from(this.pending.subarray(offset + HEADER_BYTES, end)));
      offset = end;
    }
    // Copy the remainder too: `chunk` belongs to the caller and may be reused.
    this.pending = Buffer.from(this.pending.subarray(offset));
    return frames;
  }
}

/** Binary destination for the MJPEG output (process.stdout in production). */
export type StreamSink = {
  write(chunk: Buffer): boolean;
  once(event: "drain" | "error", listener: (error?: unknown) => void): unknown;
  on(event: "drain" | "error", listener: (error?: unknown) => void): unknown;
  off(event: "drain" | "error", listener: (error?: unknown) => void): unknown;
};

export type StreamSignal = "SIGINT" | "SIGTERM";
/** Subscribes to SIGINT/SIGTERM; returns the unsubscribe function. */
export type SignalSubscriber = (handler: (signal: StreamSignal) => void) => () => void;

export type StreamRelayOptions = {
  spawnProcess: SpawnImplementation;
  /** `prlctl exec <vm> --current-user <agent> stream ...` arguments. */
  args: readonly string[];
  sink: StreamSink;
  onSignal: SignalSubscriber;
  stderr: (text: string) => void;
};

const SETUP_HINT =
  "Check that Windows is logged in, then run `transversals doctor` (or `transversals setup` to reinstall the agent).";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
}

/**
 * Spawns the guest stream relay and copies its JPEG frames to `sink` until the relay ends, the
 * sink goes away, a signal arrives, or the frame watchdog trips. Resolves to the exit code:
 * 0 for a signal or a closed sink, 1 for every relay failure.
 */
export function relayStream(options: StreamRelayOptions): Promise<number> {
  const { sink, stderr } = options;

  let child: ReturnType<SpawnImplementation>;
  try {
    child = options.spawnProcess("prlctl", options.args, {
      shell: false,
      stdio: ["pipe", "pipe", "inherit"],
    });
  } catch (error) {
    stderr(`Could not start prlctl: ${describe(error)}\n`);
    return Promise.resolve(1);
  }

  return new Promise<number>((resolvePromise) => {
    const decoder = new FrameDecoder();
    let result = 1;
    let stopping = false;
    let finished = false;
    let childExited = false;
    let sinkFull = false;
    let watchdog: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;

    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      clearTimeout(watchdog);
      clearTimeout(killTimer);
      child.stdout.off("data", onData);
      sink.off("drain", onDrain);
      sink.off("error", onSinkError);
      resolvePromise(result);
    };

    /** Starts the shutdown sequence once: end stdin, then kill after the grace period. */
    const stop = (code: number, message?: string): void => {
      if (stopping) return;
      stopping = true;
      result = code;
      if (message !== undefined) stderr(message);
      // Before stdin.end(): nothing may be written to stdin after it is ended.
      clearInterval(heartbeat);
      clearTimeout(watchdog);
      unsubscribe();
      // Any partial frame still in the decoder is simply dropped.
      try {
        child.stdin.end();
      } catch {
        // The relay's stdin is already gone.
      }
      if (childExited) {
        finish();
        return;
      }
      killTimer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        finish();
      }, KILL_GRACE_MS);
    };

    const armWatchdog = (ms: number): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        stop(1, `No video frame from the guest agent for ${ms / 1_000} s. ${SETUP_HINT}\n`);
      }, ms);
    };

    function onData(chunk: Buffer): void {
      if (stopping) return;
      let frames: Buffer[];
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        stop(1, `The guest agent sent a malformed stream: ${describe(error)}\n`);
        return;
      }
      for (const frame of frames) {
        // Dropped frames still prove the relay is alive.
        armWatchdog(FRAME_GAP_TIMEOUT_MS);
        if (sinkFull) continue;
        if (!sink.write(frame)) {
          // Drop whole frames until the consumer catches up, so it only ever sees complete JPEGs.
          sinkFull = true;
          sink.once("drain", onDrain);
        }
      }
    }

    function onDrain(): void {
      sinkFull = false;
    }

    function onSinkError(error: unknown): void {
      // A consumer closing the pipe (e.g. quitting ffplay) is a normal way to stop.
      stop(0, errorCode(error) === "EPIPE" ? undefined : `Output error: ${describe(error)}\n`);
    }

    const unsubscribe = options.onSignal(() => stop(0));

    sink.on("error", onSinkError);
    child.stdin.on("error", () => {
      // A heartbeat write to a relay that is already gone (EPIPE). The exit/error events decide the outcome.
    });
    child.stdout.on("error", () => {
      // Reported through the child's exit/error events instead.
    });
    child.stdout.on("data", onData);
    child.on("error", (error: unknown) => {
      stop(1, `prlctl failed: ${describe(error)}\n`);
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      childExited = true;
      if (stopping) {
        finish();
        return;
      }
      stop(
        1,
        `The guest stream relay exited (${signal ?? `code ${String(code)}`}). ${SETUP_HINT}\n`,
      );
    });

    heartbeat = setInterval(() => {
      if (stopping || childExited) return;
      try {
        child.stdin.write(HEARTBEAT, () => {
          // Failures are swallowed: the stdin "error" listener absorbs them and the exit code is unchanged.
        });
      } catch {
        // stdin already destroyed.
      }
    }, HEARTBEAT_INTERVAL_MS);
    armWatchdog(FIRST_FRAME_TIMEOUT_MS);
  });
}

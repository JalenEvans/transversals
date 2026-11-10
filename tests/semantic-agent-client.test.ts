import { spawn, type ChildProcessByStdio, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  SemanticAgentClient,
  type SemanticCommand,
} from "../src/semantic-agent-client.js";

type SemanticChild = ChildProcessByStdio<Writable, Readable, null>;
type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions & { stdio: ["pipe", "pipe", "ignore"] },
) => SemanticChild;

const helper = fileURLToPath(
  new URL("./helpers/fake-semantic-agent.mjs", import.meta.url),
);
const snapshot: readonly SemanticCommand[] = [{ type: "snapshot" }];

function fakeRelay(...modes: string[]): {
  spawnProcess: SpawnProcess;
  spawned: ReturnType<typeof vi.fn>;
} {
  const spawned = vi.fn();
  const spawnProcess: SpawnProcess = () => {
    const mode = modes[spawned.mock.calls.length] ?? modes.at(-1) ?? "ok";
    spawned(mode);
    return spawn(process.execPath, [helper, mode], {
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
    });
  };

  return { spawnProcess, spawned };
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Promise did not settle within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("SemanticAgentClient lifecycle", () => {
  it("rejects malformed correlated error details, invalidates the child, and reconnects queued work", async () => {
    const relay = fakeRelay("malformed-details", "ok");
    const client = new SemanticAgentClient("test-vm", "guest-agent", relay.spawnProcess);

    const active = client.execute(snapshot);
    const queued = client.execute(snapshot);

    try {
      const outcomes = await settleWithin(
        Promise.allSettled([active, queued]),
      );

      expect(outcomes[0]).toMatchObject({
        status: "rejected",
        reason: {
          code: "UPSTREAM_ERROR",
          message: "Semantic agent returned malformed error details",
        },
      });
      expect(outcomes[1]).toEqual({
        status: "fulfilled",
        value: [{ connected: true }],
      });
      expect(relay.spawned).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
    }
  });

  it("close rejects active and queued work without spawning again and remains closed", async () => {
    const relay = fakeRelay("hang", "ok");
    const client = new SemanticAgentClient("test-vm", "guest-agent", relay.spawnProcess);
    const active = client.execute(snapshot);
    const queued = client.execute(snapshot);

    await vi.waitFor(() => expect(relay.spawned).toHaveBeenCalledTimes(1));
    const closing = client.close();

    try {
      const outcomes = await settleWithin(Promise.allSettled([active, queued]));
      await settleWithin(closing);

      expect(outcomes).toEqual([
        {
          status: "rejected",
          reason: expect.objectContaining({
            code: "UPSTREAM_ERROR",
            message: "Semantic agent connection closed",
          }),
        },
        {
          status: "rejected",
          reason: expect.objectContaining({
            code: "UPSTREAM_ERROR",
            message: "Semantic agent connection closed",
          }),
        },
      ]);
      expect(relay.spawned).toHaveBeenCalledTimes(1);

      await expect(client.execute(snapshot)).rejects.toMatchObject({
        code: "UPSTREAM_ERROR",
        message: "Semantic agent connection closed",
      });
      expect(relay.spawned).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  });
});

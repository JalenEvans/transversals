import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  KEEPALIVE_INTERVAL_MS,
  SemanticAgentClient,
  type SemanticCommand,
} from "../src/semantic-agent-client.js";
import {
  AgentFailure,
  createFakeGuestAgent,
  DEFAULT_HELLO,
  type FakeChild,
} from "./helpers/fake-guest-agent.js";

// C-3 (host): NDJSON session keepalive.
//
// Contract under test (src/semantic-agent-client.ts):
// - On each newly spawned child the client first sends its own {"type":"hello"} request (inside the
//   serialized queue), before the caller's request.
// - hello protocolVersion >= 2 -> write "\n" to child.stdin every KEEPALIVE_INTERVAL_MS (5000).
//   < 2 or missing -> never.
// - A failed negotiation hello rejects the caller's request with that same error (code + message),
//   and the caller's commands are not sent.
// - Keepalives continue while a request is in flight, skip a tick while stdin.writableLength > 0,
//   stop on close()/child exit/child error/invalidate, never write after stdin.end(), and swallow
//   write errors.
// - Blank response lines from the agent are still a protocol error.

// Timing below uses a literal so a missing export fails only the export test, not every case.
const INTERVAL = 5_000;
const snapshot: readonly SemanticCommand[] = [{ type: "snapshot" }];

type FakeAgent = ReturnType<typeof createFakeGuestAgent>;

const clients: SemanticAgentClient[] = [];

function clientFor(agent: FakeAgent): SemanticAgentClient {
  const client = new SemanticAgentClient("test-vm", "guest-agent", agent.spawnProcess as never);
  clients.push(client);
  return client;
}

function v2Agent(options: Parameters<typeof createFakeGuestAgent>[0] = {}): FakeAgent {
  return createFakeGuestAgent({
    protocolVersion: 2,
    ...options,
    handlers: { snapshot: () => ({ ok: true }), ...options.handlers },
  });
}

/** Lets the fake agent's setImmediate replies and the client's promise chains run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

/** Completes one caller request so the child is spawned and negotiated. */
async function ready(client: SemanticAgentClient, agent: FakeAgent): Promise<FakeChild> {
  await expect(client.execute(snapshot)).resolves.toEqual([{ ok: true }]);
  await flush();
  const child = agent.children.at(-1);
  expect(child, "no child spawned").toBeDefined();
  return child!;
}

/** Records whether stdin had already ended at the moment of each write call. */
function spyWrites(child: FakeChild): { afterEnd: () => number; spy: ReturnType<typeof vi.spyOn> } {
  const ended: boolean[] = [];
  const original = child.stdin.write.bind(child.stdin);
  const spy = vi.spyOn(child.stdin, "write").mockImplementation(((...args: Parameters<typeof original>) => {
    ended.push(child.stdin.writableEnded);
    return original(...args);
  }) as never);
  return { afterEnd: () => ended.filter(Boolean).length, spy };
}

const requestTypes = (agent: FakeAgent): string[][] =>
  agent.requests.map((request) => request.commands.map((command) => command.type));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Negotiation hello

describe("C-3 the client negotiates with its own hello on each new child", () => {
  it("sends a hello-only request before the caller's first request, once per child", async () => {
    const agent = v2Agent();
    const client = clientFor(agent);

    await ready(client, agent);
    await client.execute(snapshot);

    expect(requestTypes(agent)).toEqual([["hello"], ["snapshot"], ["snapshot"]]);
  });

  it("negotiates again on a respawned child", async () => {
    const agent = v2Agent();
    const client = clientFor(agent);
    const first = await ready(client, agent);

    first.finish(1);
    await flush();
    await expect(client.execute(snapshot)).resolves.toEqual([{ ok: true }]);

    expect(agent.children).toHaveLength(2);
    expect(requestTypes(agent)).toEqual([["hello"], ["snapshot"], ["hello"], ["snapshot"]]);
  });

  it("gives a caller that sends its own hello that hello's result", async () => {
    const agent = v2Agent();
    const client = clientFor(agent);

    const [hello] = await client.send([{ type: "hello" }]);

    expect(hello).toEqual({ ...DEFAULT_HELLO, protocolVersion: 2 });
    expect(requestTypes(agent)).toEqual([["hello"], ["hello"]]);
  });

  it("rejects the caller's request with the negotiation error and never sends its commands", async () => {
    const agent = v2Agent({
      handlers: {
        hello: () => {
          throw new AgentFailure("BACKEND_FAILURE", "hello broke");
        },
      },
    });
    const client = clientFor(agent);

    await expect(client.execute(snapshot)).rejects.toMatchObject({
      code: "BACKEND_FAILURE",
      message: "hello broke",
    });
    expect(requestTypes(agent)).toEqual([["hello"]]);
  });
});

// ---------------------------------------------------------------------------
// KA-H1 keepalive cadence

describe("KA-H1 a protocol v2 agent gets a keepalive line every interval", () => {
  it("exports KEEPALIVE_INTERVAL_MS = 5000", () => {
    expect(KEEPALIVE_INTERVAL_MS).toBe(5_000);
  });

  it("writes \"\\n\" every 5 s after the hello while the child is alive and idle", async () => {
    const agent = v2Agent();
    const client = clientFor(agent);
    const child = await ready(client, agent);

    await tick(INTERVAL - 1);
    expect(child.keepalives).toHaveLength(0);

    await tick(1);
    expect(child.keepalives).toHaveLength(1);

    await tick(INTERVAL * 3);
    expect(child.keepalives).toHaveLength(4);
    expect(child.stdinWrites.filter((chunk) => chunk.trim().length === 0)).toEqual(Array(4).fill("\n"));
  });

  it.each([2, 3])("treats protocolVersion %i as keepalive-capable", async (protocolVersion) => {
    const agent = v2Agent({ protocolVersion });
    const client = clientFor(agent);
    const child = await ready(client, agent);

    await tick(INTERVAL * 2);

    expect(child.keepalives).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// KA-H2 compatibility gate

describe("KA-H2 older agents never get keepalives", () => {
  it.each([
    ["protocolVersion 1", 1],
    ["no protocolVersion", null],
  ] as const)("sends none to an agent reporting %s", async (_label, protocolVersion) => {
    const agent = v2Agent({ protocolVersion });
    const client = clientFor(agent);
    const child = await ready(client, agent);

    await tick(INTERVAL * 12);

    expect(child.keepalives).toHaveLength(0);
    expect(child.stdinWrites.every((chunk) => chunk.trim().length > 0)).toBe(true);
  });

  it("sends none before any request has spawned a child", async () => {
    const agent = v2Agent();
    clientFor(agent);

    await tick(INTERVAL * 4);

    expect(agent.spawnCalls).toHaveLength(0);
  });

  it("sends none until the negotiation hello has answered with v2", async () => {
    let helloId: unknown;
    const agent = v2Agent({
      rawResponse: (request) => {
        if (request.commands[0]?.type !== "hello" || helloId !== undefined) return undefined;
        helloId = request.id;
        return ""; // hold the negotiation reply
      },
    });
    const client = clientFor(agent);
    const pending = client.execute(snapshot);
    await flush();
    const child = agent.children[0]!;

    await tick(INTERVAL * 3);
    expect(child.keepalives).toHaveLength(0);

    child.stdout.write(`${JSON.stringify({ id: helloId, status: "ok", results: [{ ...DEFAULT_HELLO, protocolVersion: 2 }] })}\n`);
    await flush();
    await expect(pending).resolves.toEqual([{ ok: true }]);

    await tick(INTERVAL);
    expect(child.keepalives).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// KA-H3 no interleaving

describe("KA-H3 keepalives never interleave with request lines", () => {
  it("writes only complete lines: bare \"\\n\" keepalives or one parseable JSON request each", async () => {
    const agent = v2Agent();
    const client = clientFor(agent);
    const child = await ready(client, agent);

    for (let round = 0; round < 4; round++) {
      await tick(INTERVAL);
      await Promise.all([client.execute(snapshot), client.execute(snapshot)]);
    }

    expect(child.keepalives.length).toBeGreaterThanOrEqual(4);
    for (const chunk of child.stdinWrites) {
      expect(chunk.endsWith("\n")).toBe(true);
      if (chunk === "\n") continue;
      expect(chunk.indexOf("\n")).toBe(chunk.length - 1);
      expect(() => JSON.parse(chunk)).not.toThrow();
    }
    expect(agent.requests).toHaveLength(1 + 1 + 8);
  });

  it("skips a tick while stdin still has buffered data, then resumes", async () => {
    const agent = v2Agent();
    const client = clientFor(agent);
    const child = await ready(client, agent);

    Object.defineProperty(child.stdin, "writableLength", { configurable: true, get: () => 1 });
    await tick(INTERVAL * 2);
    expect(child.keepalives).toHaveLength(0);

    delete (child.stdin as { writableLength?: number }).writableLength;
    await tick(INTERVAL);
    expect(child.keepalives).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// KA-H4 stopping

describe("KA-H4 keepalives stop when the child goes away", () => {
  it("stops on close() and never writes after stdin.end()", async () => {
    const agent = v2Agent();
    const client = clientFor(agent);
    const child = await ready(client, agent);
    const writes = spyWrites(child);
    await tick(INTERVAL);
    expect(child.keepalives).toHaveLength(1);

    await client.close();
    await tick(INTERVAL * 6);

    expect(child.stdin.writableEnded).toBe(true);
    expect(child.keepalives).toHaveLength(1);
    expect(writes.afterEnd()).toBe(0);
  });

  it("stops when the child exits", async () => {
    const agent = v2Agent();
    const client = clientFor(agent);
    const child = await ready(client, agent);
    await tick(INTERVAL);

    child.finish(1);
    await flush();
    const writes = spyWrites(child);
    await tick(INTERVAL * 6);

    expect(writes.spy).not.toHaveBeenCalled();
    expect(child.keepalives).toHaveLength(1);
  });

  it("stops when the child emits an error", async () => {
    const agent = v2Agent();
    const client = clientFor(agent);
    const child = await ready(client, agent);

    child.emit("error", Object.assign(new Error("relay broke"), { code: "EPIPE" }));
    await flush();
    const writes = spyWrites(child);
    await tick(INTERVAL * 6);

    expect(writes.spy).not.toHaveBeenCalled();
    expect(child.keepalives).toHaveLength(0);
  });

  it("stops when the client invalidates the child after a protocol failure", async () => {
    const agent = v2Agent({
      rawResponse: (request) => (request.commands[0]?.type === "windows" ? "not json\n" : undefined),
    });
    const client = clientFor(agent);
    const child = await ready(client, agent);
    const writes = spyWrites(child);

    await expect(client.send([{ type: "windows" }])).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    await flush();
    await tick(INTERVAL * 6);

    expect(child.keepalives).toHaveLength(0);
    expect(writes.afterEnd()).toBe(0);
    expect(writes.spy.mock.calls.filter(([chunk]) => chunk === "\n")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// KA-H5 write errors

describe("KA-H5 keepalive write errors are swallowed", () => {
  it("ignores a keepalive write that fails through its callback and still serves requests", async () => {
    const agent = v2Agent();
    const client = clientFor(agent);
    const child = await ready(client, agent);
    const original = child.stdin.write.bind(child.stdin);
    vi.spyOn(child.stdin, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      if (chunk !== "\n") return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      const callback = rest.find((arg) => typeof arg === "function") as ((error?: Error) => void) | undefined;
      queueMicrotask(() => callback?.(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
      return false;
    }) as never);

    await tick(INTERVAL * 2);

    await expect(client.execute(snapshot)).resolves.toEqual([{ ok: true }]);
  });

  it("ignores a keepalive write that throws", async () => {
    const agent = v2Agent();
    const client = clientFor(agent);
    const child = await ready(client, agent);
    const original = child.stdin.write.bind(child.stdin);
    vi.spyOn(child.stdin, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      if (chunk === "\n") throw Object.assign(new Error("write after destroy"), { code: "ERR_STREAM_DESTROYED" });
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as never);

    await expect(tick(INTERVAL * 2)).resolves.toBeUndefined();

    await expect(client.execute(snapshot)).resolves.toEqual([{ ok: true }]);
  });
});

// ---------------------------------------------------------------------------
// KA-H6 response parsing unchanged

describe("KA-H6 blank response lines are still rejected", () => {
  it("fails the request when a v2 agent answers with a blank line", async () => {
    const agent = v2Agent({
      rawResponse: (request) => (request.commands[0]?.type === "windows" ? "\n" : undefined),
    });
    const client = clientFor(agent);
    await ready(client, agent);

    await expect(client.send([{ type: "windows" }])).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "Semantic agent returned an empty response",
    });
  });
});

// ---------------------------------------------------------------------------
// KA-H7 keepalives during a request

describe("KA-H7 keepalives continue while a request is in flight", () => {
  it("keeps writing keepalives during a long request, which still completes", async () => {
    let heldId: unknown;
    const agent = v2Agent({
      rawResponse: (request) => {
        if (request.commands[0]?.type !== "windows") return undefined;
        heldId = request.id;
        return ""; // answer later
      },
    });
    const client = clientFor(agent);
    const child = await ready(client, agent);

    const pending = client.send([{ type: "windows" }]);
    await flush();
    expect(heldId).toBeDefined();
    await tick(INTERVAL * 3);
    expect(child.keepalives).toHaveLength(3);

    child.stdout.write(`${JSON.stringify({ id: heldId, status: "ok", results: [[]] })}\n`);
    await expect(pending).resolves.toEqual([[]]);
  });
});

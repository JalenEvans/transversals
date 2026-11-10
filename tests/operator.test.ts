import { afterEach, describe, expect, it, vi } from "vitest";

import * as subject from "../src/index.js";

type PrlctlRequest =
  | { operation: "status" | "start"; vmId: string }
  | { operation: "restore-snapshot"; vmId: string; snapshotId: string };

type Command = {
  executable: string;
  args: readonly string[];
};

type ReadinessOptions = {
  intervalMs: number;
  timeoutMs: number;
};

function requiredExport<T>(name: string): T {
  const value = (subject as Record<string, unknown>)[name];

  if (typeof value !== "function") {
    throw new Error(`Expected src/index.ts to export function ${name}`);
  }

  return value as T;
}

describe("prlctl command boundary", () => {
  it("parses live prlctl status output without treating known VM states as unknown", () => {
    const parsePrlctlStatus = requiredExport<
      (raw: string) => "running" | "paused" | "unknown"
    >("parsePrlctlStatus");
    const vmId = "2f1db728-4d9d-4bb7-8c0d-787ea901bd42";

    expect(parsePrlctlStatus(`VM {${vmId}} exist running`)).toBe("running");
    expect(parsePrlctlStatus(`VM {${vmId}} exist paused`)).toBe("paused");
    expect(parsePrlctlStatus("unexpected output")).toBe("unknown");
  });

  it("recognizes stopped and suspended prlctl status output while rejecting malformed states", () => {
    const parsePrlctlStatus = requiredExport<
      (
        raw: string,
      ) => "running" | "paused" | "stopped" | "suspended" | "unknown"
    >("parsePrlctlStatus");
    const vmId = "2f1db728-4d9d-4bb7-8c0d-787ea901bd42";

    expect(parsePrlctlStatus(`VM {${vmId}} exist stopped`)).toBe("stopped");
    expect(parsePrlctlStatus(`VM {${vmId}} exist suspended`)).toBe(
      "suspended",
    );
    expect(parsePrlctlStatus(`VM {${vmId}} exist stopping`)).toBe("unknown");
  });

  it("represents lifecycle and snapshot restore commands as an executable plus literal arguments", () => {
    const buildPrlctlCommand = requiredExport<
      (request: PrlctlRequest) => Command
    >("buildPrlctlCommand");
    const vmId = "2f1db728-4d9d-4bb7-8c0d-787ea901bd42";
    const snapshotId = "889bf928-11ba-45fa-b7a4-64edabef1482";

    expect(
      buildPrlctlCommand({ operation: "start", vmId }),
    ).toStrictEqual({ executable: "prlctl", args: ["start", vmId] });
    expect(
      buildPrlctlCommand({
        operation: "restore-snapshot",
        vmId,
        snapshotId,
      }),
    ).toStrictEqual({
      executable: "prlctl",
      args: ["snapshot-switch", vmId, "--id", snapshotId],
    });
  });

  it("fails closed for identifiers that are not unambiguous canonical IDs", () => {
    const buildPrlctlCommand = requiredExport<
      (request: PrlctlRequest) => Command
    >("buildPrlctlCommand");
    const vmId = "2f1db728-4d9d-4bb7-8c0d-787ea901bd42";

    expect(() =>
      buildPrlctlCommand({ operation: "status", vmId: "Windows 11" }),
    ).toThrow();
    expect(() =>
      buildPrlctlCommand({
        operation: "restore-snapshot",
        vmId,
        snapshotId: "current",
      }),
    ).toThrow();
  });
});

describe("readiness polling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers from transient probe failures before reporting ready", async () => {
    vi.useFakeTimers();
    const waitForReadiness = requiredExport<
      (
        probe: () => Promise<boolean>,
        options: ReadinessOptions,
      ) => Promise<void>
    >("waitForReadiness");
    const probe = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("guest tools not available"))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const readiness = waitForReadiness(probe, {
      intervalMs: 100,
      timeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(200);

    await expect(readiness).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("stops polling at the configured timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const waitForReadiness = requiredExport<
      (
        probe: () => Promise<boolean>,
        options: ReadinessOptions,
      ) => Promise<void>
    >("waitForReadiness");
    const probe = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const startedAt = Date.now();

    const outcome = waitForReadiness(probe, {
      intervalMs: 100,
      timeoutMs: 250,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(250);

    await expect(outcome).resolves.toMatchObject({
      code: "READINESS_TIMEOUT",
    });
    expect(Date.now() - startedAt).toBe(250);
    expect(probe.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("rejects at the configured deadline when a readiness probe never settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const waitForReadiness = requiredExport<
      (
        probe: () => Promise<boolean>,
        options: ReadinessOptions,
      ) => Promise<void>
    >("waitForReadiness");
    const probe = vi.fn<() => Promise<boolean>>(
      () => new Promise<boolean>(() => undefined),
    );
    const rejection = vi.fn<(error: unknown) => void>();

    void waitForReadiness(probe, {
      intervalMs: 100,
      timeoutMs: 250,
    }).catch(rejection);

    await vi.advanceTimersByTimeAsync(250);

    expect(rejection).toHaveBeenCalledOnce();
    expect(rejection.mock.calls[0]?.[0]).toMatchObject({
      code: "READINESS_TIMEOUT",
    });
    expect(Date.now()).toBe(250);
    expect(probe).toHaveBeenCalledOnce();
  });
});

describe("R-4 retired prototype flow", () => {
  it("no longer exports runPrototypeFlow", () => {
    expect("runPrototypeFlow" in subject).toBe(false);
  });
});

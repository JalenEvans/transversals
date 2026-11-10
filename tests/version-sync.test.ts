import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// The host package and the guest agent ship the same version, so `transversals doctor`
// can require an exact match. Catches a half-done version bump.

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

const packageVersion = (JSON.parse(read("../package.json")) as { version: string }).version;

describe("V7 host and guest versions stay in sync", () => {
  it("guest csproj <Version> equals package.json version", () => {
    const csproj = read("../guest/src/Transversals.GuestAgent/Transversals.GuestAgent.csproj");
    const versions = [...csproj.matchAll(/<Version>\s*([^<\s]+)\s*<\/Version>/g)].map((match) => match[1]);

    expect(versions, "expected exactly one <Version> in the guest csproj").toHaveLength(1);
    expect(versions[0]).toBe(packageVersion);
  });

  it("package-lock.json records the same version as package.json", () => {
    const lock = JSON.parse(read("../package-lock.json")) as {
      version?: string;
      packages?: Record<string, { version?: string }>;
    };

    expect(lock.version).toBe(packageVersion);
    expect(lock.packages?.[""]?.version).toBe(packageVersion);
  });
});

import { readFileSync } from "node:fs";

import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { describe, expect, it, vi } from "vitest";

import * as subject from "../src/cli.js";
import { createFakeGuestAgent, DEFAULT_HELLO } from "./helpers/fake-guest-agent.js";

// C-005a: the `transversals` CLI (serve, setup, doctor, config).
//
// Assumed seam (see report):
//   runCli(argv: string[], deps: CliDeps): Promise<number>   // resolves to the process exit code
//   CliDeps = {
//     runCommand:   RunCommand from src/index.ts (every prlctl call, no shell)
//     spawnProcess: SpawnImplementation (agent hello probe, `prlctl exec <vm> --current-user <exe>`)
//     env:          NodeJS.ProcessEnv
//     homedir:      string
//     packageRoot:  string
//     stdout:       (text: string) => void
//     stderr:       (text: string) => void
//     readFile:     (path: string) => Promise<string>    // rejects with code ENOENT when missing
//     writeFile:    (path: string, content: string) => Promise<void>
//     mkdir:        (path: string, options: { recursive: true }) => Promise<void>
//     startServer:  (config: { vmId: string; agentExecutable: string }) => Promise<void>
//     // C-005b additions:
//     serveCommand: string[]                               // absolute launch argv, e.g. [".../transversals", "serve"]
//     prompt:       (question: string) => Promise<string>  // resolves "" when non-interactive
//     removePath:   (path: string) => Promise<void>        // recursive + force
//   }
//   runCommand also runs `claude mcp ...` (executable "claude", shell:false); ENOENT = not installed.

const VM_ID = "6d0c4a3e-91b7-4f25-8c3e-2a7b5e9f1d40";
const OTHER_VM_ID = "9c1e7a54-0d3f-4b8e-a2c6-5f4e3d2c1b0a";
const VM_NAME = "Windows 11 (Clean)";
const OTHER_VM_NAME = "Windows 11 (Dev)";
const HOME = "/Users/tester";
const PACKAGE_ROOT = "/usr/local/lib/transversals";
const CONFIG_DIR = `${HOME}/Library/Application Support/transversals`;
const CONFIG_PATH = `${CONFIG_DIR}/config.json`;
const GUEST_DIR = `${PACKAGE_ROOT}/dist/guest/win-arm64`;
const SHARE_NAME = "transversals-provision";
const GUEST_AGENT_PATH =
  "C:\\Users\\tester\\AppData\\Local\\transversals\\agent\\Transversals.GuestAgent.exe";
const OWNED_SNAPSHOT_ID = "7f7cc42d-7e68-4de1-aee8-eea2d9b09038";
const SECOND_OWNED_SNAPSHOT_ID = "3c9d6c1e-5b8a-4f0e-9d2a-6e1f0b7c4a21";
const FOREIGN_SNAPSHOT_ID = "c4e8b2a1-7f3d-4a96-b5e0-1d2c3b4a5f60";
const SERVE_COMMAND = ["/usr/local/bin/transversals", "serve"];
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const MUTATING_PRLCTL = new Set([
  "set",
  "snapshot",
  "snapshot-switch",
  "snapshot-delete",
  "start",
  "stop",
  "restart",
  "reset",
  "suspend",
  "resume",
  "pause",
  "delete",
  "register",
  "unregister",
  "clone",
]);

type RunCommand = (
  executable: string,
  args: readonly string[],
  options?: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

type CliConfig = { vmId: string; agentExecutable: string };

const runCli = (subject as unknown as {
  runCli: (argv: string[], deps: Record<string, unknown>) => Promise<number>;
}).runCli;

// ---------------------------------------------------------------------------
// Fakes

type VmEntry = { uuid: string; name: string; status: string };

function vmListJson(vms: readonly VmEntry[]): string {
  return `${JSON.stringify(
    vms.map(({ uuid, name, status }) => ({
      uuid: `{${uuid}}`,
      status,
      ip_configured: "-",
      name,
    })),
    null,
    4,
  )}\n`;
}

/** Mirrors real `prlctl snapshot-list <vm> -j` output: braced-id keys, tab indentation. */
function snapshotListJson(entries: ReadonlyArray<{ id: string; name: string }>): string {
  const body = entries
    .map(
      ({ id, name }) =>
        `\t"{${id}}": {\n\t\t"name": "${name}",\n\t\t"date": "2026-11-06 13:43:18",\n\t\t"state": "poweron",\n\t\t"current": false,\n\t\t"parent": ""\n\t}`,
    )
    .join(",\n");
  return entries.length === 0 ? "{}\n" : `{\n${body}\n}\n`;
}

type PrlctlOptions = {
  vms?: VmEntry[];
  snapshots?: Array<{ id: string; name: string }>;
  /** When false, `prlctl snapshot` "succeeds" but the snapshot never appears in later lists. */
  snapshotPersists?: boolean;
  copy?: { stdout: string } | { reject: Error };
  /** Behaviour of any other `prlctl exec` (e.g. the doctor's `cmd /c ver`). */
  execProbe?: { stdout: string } | { reject: Error };
  /** Behaviour of the `claude` executable (also routed through runCommand). */
  claude?: { missing?: boolean; addReject?: Error; removeReject?: Error };
};

function isPowerShellCopy(args: readonly string[]): boolean {
  return args[0] === "exec" && args.some((arg) => /powershell/i.test(arg));
}

/** Stateful prlctl fake driven by `prlctl list -a -j` / `snapshot-list -j` shapes. */
function createFakePrlctl(options: PrlctlOptions = {}, log: string[] = []) {
  const vms = options.vms ?? [{ uuid: VM_ID, name: VM_NAME, status: "running" }];
  const snapshots = [...(options.snapshots ?? [])];
  const copy = options.copy ?? { stdout: `${GUEST_AGENT_PATH}\r\n` };
  const execProbe = options.execProbe ?? {
    stdout: "\r\nMicrosoft Windows [Version 10.0.26100.4652]\r\n",
  };
  const claude = options.claude ?? {};

  const runCommand = vi.fn<RunCommand>(async (executable, args) => {
    log.push(`${executable} ${args.join(" ")}`);
    if (executable === "claude") {
      if (claude.missing) {
        throw Object.assign(new Error("spawn claude ENOENT"), {
          code: "ENOENT",
          errno: -2,
          syscall: "spawn claude",
          path: "claude",
        });
      }
      if (args[1] === "remove" && claude.removeReject) throw claude.removeReject;
      if (args[1] === "add" && claude.addReject) throw claude.addReject;
      return { stdout: "", stderr: "" };
    }
    const [verb] = args;
    if (verb === "snapshot-delete") {
      const id = args[args.indexOf("--id") + 1]?.replace(/[{}]/g, "").toLowerCase();
      const index = snapshots.findIndex((snapshot) => snapshot.id === id);
      if (index >= 0) snapshots.splice(index, 1);
      return { stdout: "", stderr: "" };
    }
    if (verb === "list") return { stdout: vmListJson(vms), stderr: "" };
    if (verb === "status") {
      const vm = vms.find(({ uuid }) => uuid === args[1]);
      return { stdout: `VM {${args[1]}} exist ${vm?.status ?? "stopped"}\n`, stderr: "" };
    }
    if (verb === "snapshot-list") return { stdout: snapshotListJson(snapshots), stderr: "" };
    if (verb === "snapshot") {
      if (options.snapshotPersists !== false) {
        snapshots.push({ id: OWNED_SNAPSHOT_ID, name: "transversals-baseline" });
      }
      // Deliberately unhelpful stdout: the id must be looked up by name, not parsed from here.
      return { stdout: "Creating the snapshot...\nThe snapshot has been successfully created.\n", stderr: "" };
    }
    if (isPowerShellCopy(args)) {
      if ("reject" in copy) throw copy.reject;
      return { stdout: copy.stdout, stderr: "" };
    }
    if (verb === "exec") {
      if ("reject" in execProbe) throw execProbe.reject;
      return { stdout: execProbe.stdout, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });

  const argsFor = (keep: (executable: string) => boolean): string[][] =>
    runCommand.mock.calls
      .filter(([executable]) => keep(executable))
      .map(([, args]) => [...args]);

  return {
    runCommand,
    /** Every non-`claude` call (prlctl and anything unexpected). */
    calls: (): string[][] => argsFor((executable) => executable !== "claude"),
    claudeCalls: (): string[][] => argsFor((executable) => executable === "claude"),
    executables: (): string[] => runCommand.mock.calls.map(([executable]) => executable),
  };
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
    code: "ENOENT",
  });
}

function createFakeFs(initial: Record<string, string> = {}, log: string[] = []) {
  const files = new Map<string, string>(Object.entries(initial));
  const readFile = vi.fn(async (path: string) => {
    const content = files.get(path);
    if (content === undefined) throw enoent(path);
    return content;
  });
  const writeFile = vi.fn(async (path: string, content: string) => {
    log.push(`write ${path}`);
    files.set(path, content);
  });
  const mkdir = vi.fn(async (_path: string, _options?: { recursive?: boolean }) => undefined);
  const removePath = vi.fn(async (path: string) => {
    log.push(`rm ${path}`);
    for (const key of [...files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) files.delete(key);
    }
  });
  return { files, readFile, writeFile, mkdir, removePath };
}

/**
 * A fake agent whose hello reports `agentVersion` (F1). `undefined` omits the field entirely.
 * The harness default reports the host's own package version, i.e. a matching, healthy agent.
 */
function agentReporting(agentVersion: unknown) {
  return createFakeGuestAgent({
    handlers: {
      hello: () => {
        const { agentVersion: _ignored, ...rest } = DEFAULT_HELLO;
        return agentVersion === undefined ? rest : { ...rest, agentVersion };
      },
    },
  });
}

function configFile(config: Partial<CliConfig>): Record<string, string> {
  return { [CONFIG_PATH]: `${JSON.stringify(config, null, 2)}\n` };
}

const COMPLETE_CONFIG: CliConfig = { vmId: VM_ID, agentExecutable: GUEST_AGENT_PATH };

function harness(
  options: {
    files?: Record<string, string>;
    env?: NodeJS.ProcessEnv;
    prlctl?: PrlctlOptions;
    agent?: ReturnType<typeof createFakeGuestAgent>;
    /** What the interactive prompt answers; defaults to "" (non-interactive). */
    answer?: string;
  } = {},
) {
  /** Ordered log of side effects across runCommand, writeFile and removePath. */
  const events: string[] = [];
  const fs = createFakeFs(
    {
      [`${PACKAGE_ROOT}/package.json`]: JSON.stringify({ name: "transversals-mcp", version: PACKAGE_VERSION }),
      ...options.files,
    },
    events,
  );
  const prlctl = createFakePrlctl(options.prlctl, events);
  const agent = options.agent ?? agentReporting(PACKAGE_VERSION);
  const out: string[] = [];
  const err: string[] = [];
  const startServer = vi.fn(async (_config: CliConfig) => undefined);
  const prompt = vi.fn(async (_question: string) => options.answer ?? "");
  const deps = {
    runCommand: prlctl.runCommand,
    spawnProcess: agent.spawnProcess,
    env: options.env ?? {},
    homedir: HOME,
    packageRoot: PACKAGE_ROOT,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    mkdir: fs.mkdir,
    startServer,
    serveCommand: [...SERVE_COMMAND],
    prompt,
    removePath: fs.removePath,
  };
  return {
    deps,
    fs,
    prlctl,
    agent,
    startServer,
    prompt,
    events,
    run: (...argv: string[]) => runCli(argv, deps),
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    output: () => `${out.join("")}${err.join("")}`,
    savedConfig: (): unknown => {
      const raw = fs.files.get(CONFIG_PATH);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
  };
}

function indexOfCall(calls: string[][], predicate: (args: string[]) => boolean): number {
  return calls.findIndex(predicate);
}

const isShareAdd = (args: string[]) => args[0] === "set" && args.includes("--shf-host-add");
const isShareDel = (args: string[]) => args[0] === "set" && args.includes("--shf-host-del");
const isSnapshotCreate = (args: string[]) => args[0] === "snapshot";
const isSnapshotList = (args: string[]) => args[0] === "snapshot-list";

// ---------------------------------------------------------------------------
// C5a-1 / C5a-2 config file and `transversals config`

describe("C5a-1/C5a-2 config file and `transversals config`", () => {
  it("prints the file config as JSON", async () => {
    const h = harness({ files: configFile(COMPLETE_CONFIG) });

    const code = await h.run("config");

    expect(code).toBe(0);
    expect(JSON.parse(h.stdout())).toMatchObject(COMPLETE_CONFIG);
  });

  it("prints env overrides layered over the file values", async () => {
    const h = harness({
      files: configFile(COMPLETE_CONFIG),
      env: {
        TRANSVERSALS_VM_ID: OTHER_VM_ID,
        TRANSVERSALS_UI_AGENT_EXECUTABLE: "C:\\override\\agent.exe",
      },
    });

    const code = await h.run("config");

    expect(code).toBe(0);
    expect(JSON.parse(h.stdout())).toMatchObject({
      vmId: OTHER_VM_ID,
      agentExecutable: "C:\\override\\agent.exe",
    });
  });

  it("never writes the config file when only printing it", async () => {
    const h = harness({ files: configFile(COMPLETE_CONFIG), env: { TRANSVERSALS_VM_ID: OTHER_VM_ID } });

    await h.run("config");

    expect(h.fs.writeFile).not.toHaveBeenCalled();
    expect(h.fs.mkdir).not.toHaveBeenCalled();
  });

  it("`config set vmId` normalizes a braced upper-case uuid, creates the directory and saves pretty JSON", async () => {
    const h = harness();

    const code = await h.run("config", "set", "vmId", `{${VM_ID.toUpperCase()}}`);

    expect(code).toBe(0);
    expect(h.fs.mkdir).toHaveBeenCalledWith(CONFIG_DIR, expect.objectContaining({ recursive: true }));
    expect(h.fs.writeFile).toHaveBeenCalledTimes(1);
    expect(h.fs.writeFile.mock.calls[0]![0]).toBe(CONFIG_PATH);
    const raw = h.fs.files.get(CONFIG_PATH)!;
    expect(raw.trim().split("\n").length).toBeGreaterThan(1);
    expect(JSON.parse(raw)).toEqual({ vmId: VM_ID });
  });

  it("`config set vmId` preserves the existing agentExecutable", async () => {
    const h = harness({ files: configFile({ vmId: OTHER_VM_ID, agentExecutable: GUEST_AGENT_PATH }) });

    const code = await h.run("config", "set", "vmId", VM_ID);

    expect(code).toBe(0);
    expect(h.savedConfig()).toEqual(COMPLETE_CONFIG);
  });

  it("`config set vmId` with an invalid uuid exits non-zero and writes nothing", async () => {
    const h = harness({ files: configFile(COMPLETE_CONFIG) });

    const code = await h.run("config", "set", "vmId", "not-a-uuid");

    expect(code).not.toBe(0);
    expect(h.fs.writeFile).not.toHaveBeenCalled();
    expect(h.savedConfig()).toEqual(COMPLETE_CONFIG);
  });

  it("`config set` rejects an unknown key and writes nothing", async () => {
    const h = harness({ files: configFile(COMPLETE_CONFIG) });

    const code = await h.run("config", "set", "snapshotId", VM_ID);

    expect(code).not.toBe(0);
    expect(h.fs.writeFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// C5a-3 serve

describe("C5a-3 `transversals serve`", () => {
  it("starts the server with the file config", async () => {
    const h = harness({ files: configFile(COMPLETE_CONFIG) });

    const code = await h.run("serve");

    expect(code).toBe(0);
    expect(h.startServer).toHaveBeenCalledTimes(1);
    expect(h.startServer.mock.calls[0]![0]).toMatchObject(COMPLETE_CONFIG);
  });

  it("lets env values override the file values", async () => {
    const h = harness({
      files: configFile({ vmId: OTHER_VM_ID, agentExecutable: "C:\\old\\agent.exe" }),
      env: {
        TRANSVERSALS_VM_ID: VM_ID,
        TRANSVERSALS_UI_AGENT_EXECUTABLE: GUEST_AGENT_PATH,
      },
    });

    await h.run("serve");

    expect(h.startServer).toHaveBeenCalledWith(expect.objectContaining(COMPLETE_CONFIG));
  });

  it("combines a partial file with a partial env", async () => {
    const h = harness({
      files: configFile({ vmId: VM_ID }),
      env: { TRANSVERSALS_UI_AGENT_EXECUTABLE: GUEST_AGENT_PATH },
    });

    await h.run("serve");

    expect(h.startServer).toHaveBeenCalledWith(expect.objectContaining(COMPLETE_CONFIG));
  });

  it("starts from env alone when no config file exists", async () => {
    const h = harness({
      env: { TRANSVERSALS_VM_ID: VM_ID, TRANSVERSALS_UI_AGENT_EXECUTABLE: GUEST_AGENT_PATH },
    });

    await h.run("serve");

    expect(h.startServer).toHaveBeenCalledWith(expect.objectContaining(COMPLETE_CONFIG));
  });

  it.each([
    ["no config at all", {}, {}],
    ["missing agentExecutable", configFile({ vmId: VM_ID }), {}],
    ["missing vmId", configFile({ agentExecutable: GUEST_AGENT_PATH }), {}],
  ] as const)("with %s exits non-zero, points at `transversals setup`, and does not start", async (_label, files, env) => {
    const h = harness({ files, env });

    const code = await h.run("serve");

    expect(code).not.toBe(0);
    expect(h.startServer).not.toHaveBeenCalled();
    expect(h.output()).toMatch(/transversals setup/);
  });

  it("never writes the config file", async () => {
    const h = harness({ files: configFile(COMPLETE_CONFIG) });

    await h.run("serve");

    expect(h.fs.writeFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// C5a-4 setup VM resolution

const TWO_VMS: VmEntry[] = [
  { uuid: VM_ID, name: VM_NAME, status: "running" },
  { uuid: OTHER_VM_ID, name: OTHER_VM_NAME, status: "running" },
];

function expectNothingChanged(h: ReturnType<typeof harness>): void {
  const calls = h.prlctl.calls();
  expect(calls.filter((args) => MUTATING_PRLCTL.has(args[0]!))).toEqual([]);
  expect(calls.filter((args) => args[0] === "exec")).toEqual([]);
  expect(h.fs.writeFile).not.toHaveBeenCalled();
}

describe("C5a-4 setup VM resolution", () => {
  it("resolves the VM with `prlctl list -a -j` without a shell", async () => {
    const h = harness({ prlctl: { vms: TWO_VMS } });

    await h.run("setup", "--vm", VM_NAME);

    expect(h.prlctl.calls()[0]).toEqual(["list", "-a", "-j"]);
    for (const [executable, , options] of h.prlctl.runCommand.mock.calls) {
      // C5b-7: setup now also registers with Claude Code through the same runner.
      if (executable !== "claude") expect(executable).toBe("prlctl");
      expect(options).toMatchObject({ shell: false });
    }
  });

  it("matches --vm by exact name", async () => {
    const h = harness({ prlctl: { vms: TWO_VMS } });

    const code = await h.run("setup", "--vm", VM_NAME);

    expect(code).toBe(0);
    expect(h.savedConfig()).toMatchObject({ vmId: VM_ID });
  });

  it.each([VM_ID, `{${VM_ID}}`])("matches --vm by uuid (%s)", async (vmArg) => {
    const h = harness({ prlctl: { vms: TWO_VMS } });

    const code = await h.run("setup", "--vm", vmArg);

    expect(code).toBe(0);
    expect(h.savedConfig()).toMatchObject({ vmId: VM_ID });
  });

  it("exits non-zero and changes nothing when --vm matches no VM", async () => {
    const h = harness({ prlctl: { vms: TWO_VMS } });

    const code = await h.run("setup", "--vm", "Windows 11");

    expect(code).not.toBe(0);
    expectNothingChanged(h);
  });

  it("exits non-zero and changes nothing when --vm matches more than one VM by name", async () => {
    const h = harness({
      prlctl: {
        vms: [
          { uuid: VM_ID, name: VM_NAME, status: "running" },
          { uuid: OTHER_VM_ID, name: VM_NAME, status: "running" },
        ],
      },
    });

    const code = await h.run("setup", "--vm", VM_NAME);

    expect(code).not.toBe(0);
    expectNothingChanged(h);
  });

  it("uses the only VM when --vm is omitted", async () => {
    const h = harness();

    const code = await h.run("setup");

    expect(code).toBe(0);
    expect(h.savedConfig()).toMatchObject({ vmId: VM_ID });
  });

  it("lists the VM names and asks for --vm when several exist and --vm is omitted", async () => {
    const h = harness({ prlctl: { vms: TWO_VMS } });

    const code = await h.run("setup");

    expect(code).not.toBe(0);
    expect(h.output()).toContain(VM_NAME);
    expect(h.output()).toContain(OTHER_VM_NAME);
    expect(h.output()).toContain("--vm");
    expectNothingChanged(h);
  });

  it("refuses a VM that is not running, hints to start it, and does not start it", async () => {
    const h = harness({ prlctl: { vms: [{ uuid: VM_ID, name: VM_NAME, status: "stopped" }] } });

    const code = await h.run("setup", "--vm", VM_NAME);

    expect(code).not.toBe(0);
    expect(h.output()).toMatch(/start/i);
    expectNothingChanged(h);
  });
});

// ---------------------------------------------------------------------------
// C5a-5 provisioning sequence

describe("C5a-5 setup provisioning", () => {
  it("adds a read-only share, copies via PowerShell, then removes the share, in that order", async () => {
    const h = harness();

    const code = await h.run("setup", "--vm", VM_NAME);

    expect(code).toBe(0);
    const calls = h.prlctl.calls();
    const addIndex = indexOfCall(calls, isShareAdd);
    const copyIndex = indexOfCall(calls, isPowerShellCopy);
    const delIndex = indexOfCall(calls, isShareDel);

    expect(calls[addIndex]).toEqual([
      "set",
      VM_ID,
      "--shf-host-add",
      SHARE_NAME,
      "--path",
      GUEST_DIR,
      "--mode",
      "ro",
    ]);
    expect(calls[delIndex]).toEqual(["set", VM_ID, "--shf-host-del", SHARE_NAME]);
    expect(addIndex).toBeGreaterThanOrEqual(0);
    expect(copyIndex).toBeGreaterThan(addIndex);
    expect(delIndex).toBeGreaterThan(copyIndex);
    expect(calls.filter(isShareAdd)).toHaveLength(1);
    expect(calls.filter(isShareDel)).toHaveLength(1);
  });

  it("copies the agent from the share into %LOCALAPPDATA%\\transversals\\agent as the current user", async () => {
    const h = harness();

    await h.run("setup", "--vm", VM_NAME);

    const copy = h.prlctl.calls().find(isPowerShellCopy);
    expect(copy).toBeDefined();
    if (!copy) return;
    expect(copy.slice(0, 3)).toEqual(["exec", VM_ID, "--current-user"]);
    expect(copy[3]).toMatch(/^powershell(\.exe)?$/i);
    const script = copy.slice(4).join(" ");
    expect(script).toContain(`\\\\Mac\\${SHARE_NAME}\\`);
    expect(script).toContain("Transversals.GuestAgent.exe");
    expect(script).toContain("LOCALAPPDATA");
    expect(script).toContain("transversals\\agent");
  });

  it("removes the share even when the guest copy fails, then exits non-zero without saving", async () => {
    const h = harness({
      prlctl: { copy: { reject: Object.assign(new Error("Command failed: prlctl exec"), { code: 1 }) } },
    });

    const code = await h.run("setup", "--vm", VM_NAME);

    expect(code).not.toBe(0);
    const calls = h.prlctl.calls();
    expect(indexOfCall(calls, isShareDel)).toBeGreaterThan(indexOfCall(calls, isPowerShellCopy));
    expect(calls.filter(isShareDel)).toEqual([["set", VM_ID, "--shf-host-del", SHARE_NAME]]);
    expect(calls.filter(isSnapshotCreate)).toEqual([]);
    expect(h.fs.writeFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// C-4 ND1–ND3 the agent's native DLLs ship beside the exe, so setup copies the share directory

async function guestCopyScript(): Promise<string> {
  const h = harness();
  await h.run("setup", "--vm", VM_NAME);
  const copy = h.prlctl.calls().find(isPowerShellCopy);
  expect(copy, "setup ran no guest copy").toBeDefined();
  // Everything after `powershell.exe` (flags + -Command script), as the guest command line sees it.
  return copy!.slice(4).join(" ");
}

describe("C-4 setup copies the whole agent directory, exe first", () => {
  it("ND1 copies the share directory's other files, after the exe", async () => {
    const script = await guestCopyScript();

    // The exe copy: the first copy operation, still from the exe on the share.
    const exeCopy = script.search(/Copy-Item[^;]*\$src/i);
    expect(exeCopy, "no exe copy from $src").toBeGreaterThanOrEqual(0);
    // Not exe-only: a listing/wildcard of the share directory feeds a second copy.
    const directoryCopy = script.search(/Get-ChildItem|\bgci\b|\\\*/i);
    expect(directoryCopy, "script never enumerates the share directory").toBeGreaterThanOrEqual(0);
    expect(directoryCopy).toBeGreaterThan(exeCopy);
    expect(script.slice(directoryCopy)).toMatch(/Copy-Item/i);
    // The wait for the exe (source-missing) still precedes any copy.
    expect(script.indexOf("source-missing")).toBeGreaterThanOrEqual(0);
    expect(script.indexOf("source-missing")).toBeLessThan(exeCopy);
  });

  it("ND1 maps failures copying the other files to the same markers", async () => {
    const script = await guestCopyScript();
    const directoryCopy = script.search(/Get-ChildItem|\bgci\b|\\\*/i);
    expect(directoryCopy).toBeGreaterThanOrEqual(0);

    const rest = script.slice(directoryCopy);
    expect(rest).toMatch(/\bcatch\b/i);
    expect(rest).toContain("TRANSVERSALS_ERROR");
  });

  it("ND1 still prints only the resolved exe path, last", async () => {
    const script = await guestCopyScript();

    const outputs = [...script.matchAll(/WriteLine\(|Write-Output|Write-Host|\becho\b/gi)].map((match) => match.index!);
    const plain = outputs.filter((index) => !script.slice(index, index + 80).includes("TRANSVERSALS_ERROR"));
    expect(plain).toHaveLength(1);
    expect(script.slice(plain[0]!)).toMatch(/Resolve-Path[^;]*\$dst/i);
    const directoryCopy = script.search(/Get-ChildItem|\bgci\b|\\\*/i);
    expect(directoryCopy, "script never enumerates the share directory").toBeGreaterThanOrEqual(0);
    expect(plain[0]!).toBeGreaterThan(directoryCopy);
  });

  it("ND1 avoids double quotes and cmd metacharacters (| & < > ^)", async () => {
    const script = await guestCopyScript();

    expect(script).not.toMatch(/["|&<>^]/);
  });

  it("ND2 still saves the installed exe path as agentExecutable", async () => {
    const h = harness();

    const code = await h.run("setup", "--vm", VM_NAME);

    expect(code).toBe(0);
    expect(h.savedConfig()).toEqual({ vmId: VM_ID, agentExecutable: GUEST_AGENT_PATH });
    expect(GUEST_AGENT_PATH).toMatch(/\\transversals\\agent\\Transversals\.GuestAgent\.exe$/i);
  });
});

describe("ND3 guest copy markers map to their messages", () => {
  const withStdoutOnFailure = (stdout: string) => ({
    reject: Object.assign(new Error("Command failed: prlctl exec"), { code: 3, stdout, stderr: "" }),
  });

  it.each([
    ["source-missing", { stdout: "TRANSVERSALS_ERROR source-missing\r\n" }, /npm run guest:publish/],
    ["destination-locked", { stdout: "TRANSVERSALS_ERROR destination-locked\r\n" }, /in use and could not be replaced/],
    ["copy-failed", { stdout: "TRANSVERSALS_ERROR copy-failed disk full\r\n" }, /Copying the guest agent failed: disk full/],
    ["destination-locked (non-zero exit)", withStdoutOnFailure("TRANSVERSALS_ERROR destination-locked\r\n"), /in use and could not be replaced/],
  ] as const)("%s fails setup with its message, removes the share and saves nothing", async (_label, copy, message) => {
    const h = harness({ prlctl: { copy } });

    const code = await h.run("setup", "--vm", VM_NAME);

    expect(code).not.toBe(0);
    expect(h.stderr()).toMatch(message);
    const calls = h.prlctl.calls();
    expect(indexOfCall(calls, isShareDel)).toBeGreaterThan(indexOfCall(calls, isPowerShellCopy));
    expect(calls.filter(isSnapshotCreate)).toEqual([]);
    expect(h.fs.writeFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// C5a-6 agent verification and saved config

describe("C5a-6 setup verifies the installed agent and saves config", () => {
  it("spawns the installed agent at the guest path printed by the copy and says hello", async () => {
    const h = harness();

    await h.run("setup", "--vm", VM_NAME);

    expect(h.agent.spawnCalls.length).toBeGreaterThanOrEqual(1);
    expect(h.agent.spawnCalls[0]).toMatchObject({
      command: "prlctl",
      args: ["exec", VM_ID, "--current-user", GUEST_AGENT_PATH],
    });
    expect(h.agent.commands().map(({ type }) => type)).toContain("hello");
  });

  it("saves vmId and the printed guest path to the config file", async () => {
    const h = harness();

    const code = await h.run("setup", "--vm", VM_NAME);

    expect(code).toBe(0);
    expect(h.fs.mkdir).toHaveBeenCalledWith(CONFIG_DIR, expect.objectContaining({ recursive: true }));
    expect(h.savedConfig()).toEqual(COMPLETE_CONFIG);
  });

  it("exits non-zero and saves nothing when the agent hello fails", async () => {
    const h = harness({ agent: createFakeGuestAgent({ behavior: "exit-before-response" }) });

    const code = await h.run("setup", "--vm", VM_NAME);

    expect(code).not.toBe(0);
    expect(h.fs.writeFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// C5a-7 owned snapshot

describe("C5a-7 setup owned snapshot", () => {
  it("creates `transversals-baseline` when none exists, after the share is removed, and confirms by re-listing", async () => {
    const h = harness({ prlctl: { snapshots: [{ id: FOREIGN_SNAPSHOT_ID, name: "vm-operator-baseline" }] } });

    const code = await h.run("setup", "--vm", VM_NAME);

    expect(code).toBe(0);
    const calls = h.prlctl.calls();
    expect(calls.filter(isSnapshotCreate)).toEqual([
      ["snapshot", VM_ID, "--name", "transversals-baseline"],
    ]);
    const createIndex = indexOfCall(calls, isSnapshotCreate);
    expect(createIndex).toBeGreaterThan(indexOfCall(calls, isShareDel));
    expect(indexOfCall(calls, isSnapshotList)).toBeLessThan(createIndex);
    expect(calls.slice(createIndex + 1).some(isSnapshotList)).toBe(true);
    for (const args of calls.filter(isSnapshotList)) {
      expect(args).toEqual(["snapshot-list", VM_ID, "-j"]);
    }
  });

  it("exits non-zero when the created snapshot cannot be found on re-listing", async () => {
    const h = harness({ prlctl: { snapshotPersists: false } });

    const code = await h.run("setup", "--vm", VM_NAME);

    expect(code).not.toBe(0);
  });

  it("leaves an existing single `transversals-baseline` alone and says so", async () => {
    const h = harness({ prlctl: { snapshots: [{ id: OWNED_SNAPSHOT_ID, name: "transversals-baseline" }] } });

    const code = await h.run("setup", "--vm", VM_NAME);

    expect(code).toBe(0);
    expect(h.prlctl.calls().filter(isSnapshotCreate)).toEqual([]);
    expect(h.output()).toContain("transversals-baseline");
  });

  it("warns and does not create when more than one `transversals-baseline` exists", async () => {
    const h = harness({
      prlctl: {
        snapshots: [
          { id: OWNED_SNAPSHOT_ID, name: "transversals-baseline" },
          { id: SECOND_OWNED_SNAPSHOT_ID, name: "transversals-baseline" },
        ],
      },
    });

    await h.run("setup", "--vm", VM_NAME);

    expect(h.prlctl.calls().filter(isSnapshotCreate)).toEqual([]);
    expect(h.output()).toContain("transversals-baseline");
  });
});

// ---------------------------------------------------------------------------
// C5a-8 doctor

function expectReadOnly(h: ReturnType<typeof harness>): void {
  const mutating = h.prlctl.calls().filter((args) => MUTATING_PRLCTL.has(args[0]!));
  expect(mutating).toEqual([]);
  expect(h.prlctl.calls().filter(isPowerShellCopy)).toEqual([]);
  expect(h.fs.writeFile).not.toHaveBeenCalled();
  expect(h.fs.mkdir).not.toHaveBeenCalled();
}

const HEALTHY_SNAPSHOTS = [{ id: OWNED_SNAPSHOT_ID, name: "transversals-baseline" }];

describe("C5a-8 `transversals doctor`", () => {
  it("passes every check, reports the agent version, and exits 0 on a healthy setup", async () => {
    const h = harness({ files: configFile(COMPLETE_CONFIG), prlctl: { snapshots: HEALTHY_SNAPSHOTS } });

    const code = await h.run("doctor");

    expect(code).toBe(0);
    expect(h.output()).toContain(PACKAGE_VERSION);
    expect(h.output()).not.toMatch(/fail/i);
    expect(h.prlctl.calls().some((args) => args[0] === "exec")).toBe(true);
    expect(h.agent.spawnCalls[0]).toMatchObject({
      args: ["exec", VM_ID, "--current-user", GUEST_AGENT_PATH],
    });
    expectReadOnly(h);
  });

  it.each([
    ["config is missing", { files: {} }],
    ["the VM does not exist", { prlctl: { vms: [{ uuid: OTHER_VM_ID, name: OTHER_VM_NAME, status: "running" }], snapshots: HEALTHY_SNAPSHOTS } }],
    ["the VM is not running", { prlctl: { vms: [{ uuid: VM_ID, name: VM_NAME, status: "stopped" }], snapshots: HEALTHY_SNAPSHOTS } }],
    ["Parallels Tools exec fails", { prlctl: { snapshots: HEALTHY_SNAPSHOTS, execProbe: { reject: new Error("Command failed: prlctl exec") } } }],
    ["the agent hello fails", { prlctl: { snapshots: HEALTHY_SNAPSHOTS }, agent: createFakeGuestAgent({ behavior: "exit-before-response" }) }],
    ["the owned snapshot is missing", { prlctl: { snapshots: [] } }],
    ["the owned snapshot is duplicated", { prlctl: { snapshots: [...HEALTHY_SNAPSHOTS, { id: SECOND_OWNED_SNAPSHOT_ID, name: "transversals-baseline" }] } }],
  ] as const)("reports a failure, exits non-zero, and stays read-only when %s", async (_label, overrides) => {
    const h = harness({ files: configFile(COMPLETE_CONFIG), ...overrides } as Parameters<typeof harness>[0]);

    const code = await h.run("doctor");

    expect(code).not.toBe(0);
    expect(h.output()).toMatch(/fail/i);
    expectReadOnly(h);
  });
});

// ---------------------------------------------------------------------------
// F1 V1–V6 guest agent version vs host package version

/** The doctor's "guest agent" report line, e.g. "PASS  guest agent       version 0.2.0 at C:\...". */
function guestAgentLine(output: string): string {
  const line = output.split(/\r?\n/).find((entry) => /^(PASS|FAIL|SKIP)\s+guest agent\b/.test(entry));
  expect(line, `no "guest agent" line in doctor output:\n${output}`).toBeDefined();
  return line ?? "";
}

// Deliberately unrelated to PACKAGE_VERSION so "names both versions" can't pass by substring.
const STALE_VERSION = "0.0.1";

describe("F1 doctor compares the guest agent version with the host version", () => {
  const healthy = { files: configFile(COMPLETE_CONFIG), prlctl: { snapshots: HEALTHY_SNAPSHOTS } };

  it("V1 passes with `version X at <path>` when the agent reports the host package version", async () => {
    const h = harness(healthy);

    const code = await h.run("doctor");

    expect(code).toBe(0);
    const line = guestAgentLine(h.stdout());
    expect(line).toMatch(/^PASS\s/);
    expect(line).toContain(`version ${PACKAGE_VERSION} at ${GUEST_AGENT_PATH}`);
  });

  it.each([
    ["an older version", STALE_VERSION],
    ["a prerelease of the host version", `${PACKAGE_VERSION}-rc.1`],
    ["the host version with build metadata", `${PACKAGE_VERSION}+abc123`],
  ])("V2 fails naming both versions with a setup hint when the agent reports %s", async (_label, agentVersion) => {
    const h = harness({ ...healthy, agent: agentReporting(agentVersion) });

    const code = await h.run("doctor");

    expect(code).toBe(1);
    const line = guestAgentLine(h.stdout());
    expect(line).toMatch(/^FAIL\s/);
    expect(line).toContain(agentVersion);
    expect(line.replace(agentVersion, "")).toContain(PACKAGE_VERSION);
    expect(line).toContain("transversals setup");
    // Only the version check fails; the other checks still run and pass.
    expect(h.stdout()).toMatch(/^PASS\s+baseline snapshot/m);
    expect(h.stdout().match(/^FAIL/gm)).toHaveLength(1);
    expectReadOnly(h);
  });

  it.each([
    ["omits agentVersion", undefined],
    ["reports an empty agentVersion", ""],
    ["reports a non-string agentVersion", 2],
  ])("V3 treats an agent that %s as version \"unknown\" and fails", async (_label, agentVersion) => {
    const h = harness({ ...healthy, agent: agentReporting(agentVersion) });

    const code = await h.run("doctor");

    expect(code).toBe(1);
    const line = guestAgentLine(h.stdout());
    expect(line).toMatch(/^FAIL\s/);
    expect(line).toContain("unknown");
    expect(line).toContain(PACKAGE_VERSION);
    expect(line).toContain("transversals setup");
    expectReadOnly(h);
  });

  it("V4 keeps the existing no-hello failure when the agent does not answer", async () => {
    const h = harness({ ...healthy, agent: createFakeGuestAgent({ behavior: "exit-before-response" }) });

    const code = await h.run("doctor");

    expect(code).toBe(1);
    const line = guestAgentLine(h.stdout());
    expect(line).toMatch(/^FAIL\s/);
    expect(line).toContain(`No hello from ${GUEST_AGENT_PATH}`);
    expect(line).toContain("transversals setup");
    expect(line).not.toContain("unknown");
  });
});

// ---------------------------------------------------------------------------
// DL1–DL6 doctor reports native DLLs the agent's hello says are missing

const NATIVE_FILES = ["wpfgfx_cor3.dll", "PresentationNative_cor3.dll", "vcruntime140_cor3.dll", "PenImc_cor3.dll"];

/** A matching-version agent whose hello reports `missingNativeFiles` (`undefined` omits the field). */
function agentMissing(missingNativeFiles: unknown) {
  return createFakeGuestAgent({
    handlers: {
      hello: () => {
        const { missingNativeFiles: _ignored, ...rest } = DEFAULT_HELLO;
        const base = { ...rest, agentVersion: PACKAGE_VERSION };
        return missingNativeFiles === undefined ? base : { ...base, missingNativeFiles };
      },
    },
  });
}

describe("DL doctor checks the agent's native DLLs through hello", () => {
  const healthy = { files: configFile(COMPLETE_CONFIG), prlctl: { snapshots: HEALTHY_SNAPSHOTS } };

  it("DL1 passes unchanged when no native files are missing", async () => {
    const h = harness({ ...healthy, agent: agentMissing([]) });

    const code = await h.run("doctor");

    expect(code).toBe(0);
    const line = guestAgentLine(h.stdout());
    expect(line).toMatch(/^PASS\s/);
    expect(line).toContain(`version ${PACKAGE_VERSION} at ${GUEST_AGENT_PATH}`);
    for (const name of NATIVE_FILES) expect(h.output()).not.toContain(name);
  });

  it.each([
    ["two", ["wpfgfx_cor3.dll", "PenImc_cor3.dll"]],
    ["all four", NATIVE_FILES],
  ])("DL2/DL3 fails naming exactly the missing files (%s) with a setup hint", async (_label, missing) => {
    const h = harness({ ...healthy, agent: agentMissing(missing) });

    const code = await h.run("doctor");

    expect(code).toBe(1);
    const line = guestAgentLine(h.stdout());
    expect(line).toMatch(/^FAIL\s/);
    for (const name of missing) expect(line).toContain(name);
    for (const name of NATIVE_FILES.filter((file) => !missing.includes(file))) expect(line).not.toContain(name);
    expect(line).toContain("Rerun `transversals setup`");
    // Only this check fails; the rest still run and pass.
    expect(h.stdout()).toMatch(/^PASS\s+baseline snapshot/m);
    expect(h.stdout().match(/^FAIL/gm)).toHaveLength(1);
    expectReadOnly(h);
  });

  it("DL4 reports the version mismatch, not missing files, when both are wrong", async () => {
    const agent = createFakeGuestAgent({
      handlers: { hello: () => ({ ...DEFAULT_HELLO, agentVersion: STALE_VERSION, missingNativeFiles: NATIVE_FILES }) },
    });
    const h = harness({ ...healthy, agent });

    const code = await h.run("doctor");

    expect(code).toBe(1);
    const line = guestAgentLine(h.stdout());
    expect(line).toMatch(/^FAIL\s/);
    expect(line).toContain(`Guest agent is ${STALE_VERSION} but this host is ${PACKAGE_VERSION}`);
    for (const name of NATIVE_FILES) expect(h.output()).not.toContain(name);
  });

  it("DL4 keeps the no-hello failure without any missing-file text", async () => {
    const h = harness({ ...healthy, agent: createFakeGuestAgent({ behavior: "exit-before-response" }) });

    const code = await h.run("doctor");

    expect(code).toBe(1);
    const line = guestAgentLine(h.stdout());
    expect(line).toContain(`No hello from ${GUEST_AGENT_PATH}`);
    expect(line).not.toMatch(/native|\.dll/i);
  });

  it("DL5 passes without a DLL check when hello has no missingNativeFiles field", async () => {
    const h = harness({ ...healthy, agent: agentMissing(undefined) });

    const code = await h.run("doctor");

    expect(code).toBe(0);
    const line = guestAgentLine(h.stdout());
    expect(line).toMatch(/^PASS\s/);
    expect(line).toContain(`version ${PACKAGE_VERSION} at ${GUEST_AGENT_PATH}`);
  });

  it.each([
    ["a string", "x"],
    ["an array with a number", [1]],
    ["an array mixing names and null", ["wpfgfx_cor3.dll", null]],
    ["null", null],
    ["an object", { "wpfgfx_cor3.dll": true }],
  ])("DL6 fails with the setup hint when missingNativeFiles is %s", async (_label, missingNativeFiles) => {
    const h = harness({ ...healthy, agent: agentMissing(missingNativeFiles) });

    const code = await h.run("doctor");

    expect(code).toBe(1);
    const line = guestAgentLine(h.stdout());
    expect(line).toMatch(/^FAIL\s/);
    expect(line).toContain("Rerun `transversals setup`");
    expect(h.stdout().match(/^FAIL/gm)).toHaveLength(1);
    expectReadOnly(h);
  });
});

describe("F1 setup warns when the installed agent's version differs from the host", () => {
  it("V5 reports the matching version without a warning", async () => {
    const h = harness();

    const code = await h.run("setup", "--vm", VM_NAME);

    expect(code).toBe(0);
    expect(h.stdout()).toContain(`Guest agent ${PACKAGE_VERSION} responded.`);
    expect(h.output()).not.toContain("guest:publish");
    expect(h.stderr()).not.toMatch(/version|stale|mismatch/i);
  });

  it.each([
    ["an older version", STALE_VERSION, STALE_VERSION],
    ["no version", undefined, "unknown"],
  ])("V6 warns on stderr naming both versions when the agent reports %s, and still succeeds", async (_label, agentVersion, shown) => {
    const h = harness({ agent: agentReporting(agentVersion) });

    const code = await h.run("setup", "--vm", VM_NAME);

    expect(code).toBe(0);
    const stderr = h.stderr();
    expect(stderr).toContain(shown);
    expect(stderr.replace(shown, "")).toContain(PACKAGE_VERSION);
    expect(stderr).toContain("npm run guest:publish");
    expect(h.stdout()).not.toContain("guest:publish");
    // Setup still completes: config saved and the baseline snapshot created.
    expect(h.savedConfig()).toEqual(COMPLETE_CONFIG);
    expect(h.prlctl.calls().some(isSnapshotCreate)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C5a-9 usage and version

describe("C5a-9 usage and version", () => {
  it("--help lists every command and exits 0", async () => {
    const h = harness();

    const code = await h.run("--help");

    expect(code).toBe(0);
    for (const command of ["serve", "setup", "doctor", "config"]) {
      expect(h.output()).toContain(command);
    }
  });

  it("an unknown command prints usage and exits non-zero", async () => {
    const h = harness();

    const code = await h.run("frobnicate");

    expect(code).not.toBe(0);
    for (const command of ["serve", "setup", "doctor", "config"]) {
      expect(h.output()).toContain(command);
    }
    expect(h.startServer).not.toHaveBeenCalled();
  });

  it("--version prints the package.json version", async () => {
    const h = harness();

    const code = await h.run("--version");

    expect(code).toBe(0);
    expect(h.stdout().trim()).toBe(PACKAGE_VERSION);
  });
});

// ===========================================================================
// C-005b: MCP client registration (`register`, setup hook) and `uninstall`.

const OPENCODE_DIR = `${HOME}/.config/opencode`;
const OPENCODE_JSONC = `${OPENCODE_DIR}/opencode.jsonc`;
const OPENCODE_JSON = `${OPENCODE_DIR}/opencode.json`;
const BACKUP_SUFFIX = ".transversals-backup";
const DESIRED_ENTRY = { type: "local", command: SERVE_COMMAND, enabled: true };
const OTHER_ENTRY = { type: "local", command: ["npx", "-y", "example-mcp"] };
const CLAUDE_REMOVE = ["mcp", "remove", "-s", "user", "transversals"];
const CLAUDE_ADD = ["mcp", "add", "-s", "user", "transversals", "--", ...SERVE_COMMAND];
const UNINSTALL_PACKAGE_COMMANDS = [
  "sudo rm -rf /usr/local/lib/transversals /usr/local/bin/transversals",
  "sudo pkgutil --forget io.github.jalenevans.transversals",
];

/** Real-world layout: servers under `mcp.servers`, with comments and trailing commas. */
const SERVERS_LAYOUT_JSONC = [
  "{",
  "  // my OpenCode config",
  '  "$schema": "https://opencode.ai/config.json",',
  "  /* MCP servers live under mcp.servers */",
  '  "mcp": {',
  '    "servers": {',
  '      "other": { "type": "local", "command": ["npx", "-y", "example-mcp"] }, // keep me',
  "    },",
  "  },",
  '  "theme": "dark", /* trailing comment */',
  "}",
  "",
].join("\n");
const OTHER_PROPERTY_TEXT = '"other": { "type": "local", "command": ["npx", "-y", "example-mcp"] }';

function parseStrictJsonc(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true }) as Record<string, unknown>;
  expect(errors).toEqual([]);
  return value;
}

function mcpOf(text: string): Record<string, any> {
  return (parseStrictJsonc(text).mcp ?? {}) as Record<string, any>;
}

function isGuestPowerShell(args: readonly string[]): boolean {
  return args[0] === "exec" && args.some((arg) => /powershell/i.test(arg));
}

// ---------------------------------------------------------------------------
// C5b-1 register command

describe("C5b-1 `transversals register`", () => {
  it("registers with every detected client and reminds the user to restart both", async () => {
    const h = harness({ files: { [OPENCODE_JSON]: "{}\n" } });

    const code = await h.run("register");

    expect(code).toBe(0);
    expect(h.prlctl.claudeCalls()).toContainEqual(CLAUDE_ADD);
    expect(mcpOf(h.fs.files.get(OPENCODE_JSON)!).transversals).toEqual(DESIRED_ENTRY);
    expect(h.output()).toMatch(/restart/i);
    expect(h.output()).toContain("OpenCode");
    expect(h.output()).toContain("Claude Code");
  });

  it("`--client claude` registers only with Claude Code", async () => {
    const h = harness({ files: { [OPENCODE_JSON]: "{}\n" } });

    const code = await h.run("register", "--client", "claude");

    expect(code).toBe(0);
    expect(h.prlctl.claudeCalls()).toContainEqual(CLAUDE_ADD);
    expect(h.fs.writeFile).not.toHaveBeenCalled();
    expect(h.fs.files.get(OPENCODE_JSON)).toBe("{}\n");
  });

  it("`--client opencode` registers only with OpenCode", async () => {
    const h = harness({ files: { [OPENCODE_JSON]: "{}\n" } });

    const code = await h.run("register", "--client", "opencode");

    expect(code).toBe(0);
    expect(h.prlctl.claudeCalls()).toEqual([]);
    expect(mcpOf(h.fs.files.get(OPENCODE_JSON)!).transversals).toEqual(DESIRED_ENTRY);
  });

  it("reports a skipped client alongside a registered one", async () => {
    const h = harness({ files: { [OPENCODE_JSON]: "{}\n" }, prlctl: { claude: { missing: true } } });

    const code = await h.run("register");

    expect(code).toBe(0);
    expect(h.output()).toContain("Claude Code not found");
    expect(mcpOf(h.fs.files.get(OPENCODE_JSON)!).transversals).toEqual(DESIRED_ENTRY);
  });
});

// ---------------------------------------------------------------------------
// C5b-2 Claude Code

describe("C5b-2 Claude Code registration", () => {
  it("removes then adds the user-scoped server with the serve command, without a shell", async () => {
    const h = harness();

    const code = await h.run("register", "--client", "claude");

    expect(code).toBe(0);
    expect(h.prlctl.claudeCalls()).toEqual([CLAUDE_REMOVE, CLAUDE_ADD]);
    for (const [executable, , options] of h.prlctl.runCommand.mock.calls) {
      if (executable === "claude") expect(options).toMatchObject({ shell: false });
    }
  });

  it("ignores a failing remove (nothing registered yet) and still adds", async () => {
    const h = harness({
      prlctl: {
        claude: {
          removeReject: Object.assign(new Error("Command failed: claude mcp remove -s user transversals"), {
            code: 1,
            stderr: "No MCP server found with name: transversals\n",
          }),
        },
      },
    });

    const code = await h.run("register", "--client", "claude");

    expect(code).toBe(0);
    expect(h.prlctl.claudeCalls()).toContainEqual(CLAUDE_ADD);
  });

  it("skips with `Claude Code not found` when `claude` cannot be spawned", async () => {
    const h = harness({ prlctl: { claude: { missing: true } } });

    const code = await h.run("register", "--client", "claude");

    expect(code).toBe(0);
    expect(h.output()).toContain("Claude Code not found");
  });

  it("exits non-zero when `claude mcp add` fails", async () => {
    const h = harness({
      prlctl: { claude: { addReject: Object.assign(new Error("Command failed: claude mcp add"), { code: 1 }) } },
    });

    const code = await h.run("register", "--client", "claude");

    expect(code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C5b-3 OpenCode config discovery

describe("C5b-3 OpenCode config discovery", () => {
  it("prefers opencode.jsonc over opencode.json", async () => {
    const h = harness({ files: { [OPENCODE_JSONC]: "{}\n", [OPENCODE_JSON]: "{}\n" } });

    const code = await h.run("register", "--client", "opencode");

    expect(code).toBe(0);
    expect(mcpOf(h.fs.files.get(OPENCODE_JSONC)!).transversals).toEqual(DESIRED_ENTRY);
    expect(h.fs.files.get(OPENCODE_JSON)).toBe("{}\n");
    expect(h.fs.writeFile.mock.calls.map(([path]) => path)).not.toContain(OPENCODE_JSON);
  });

  it("falls back to opencode.json", async () => {
    const h = harness({ files: { [OPENCODE_JSON]: "{}\n" } });

    await h.run("register", "--client", "opencode");

    expect(mcpOf(h.fs.files.get(OPENCODE_JSON)!).transversals).toEqual(DESIRED_ENTRY);
  });

  it("skips with `OpenCode config not found` and creates nothing when neither exists", async () => {
    const h = harness();

    const code = await h.run("register");

    expect(code).toBe(0);
    expect(h.output()).toContain("OpenCode config not found");
    expect(h.fs.writeFile).not.toHaveBeenCalled();
    expect(h.fs.mkdir).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// C5b-4 OpenCode entry placement

describe("C5b-4 OpenCode entry placement", () => {
  it("writes mcp.servers.transversals when mcp.servers is an object", async () => {
    const h = harness({ files: { [OPENCODE_JSONC]: SERVERS_LAYOUT_JSONC } });

    await h.run("register", "--client", "opencode");

    const mcp = mcpOf(h.fs.files.get(OPENCODE_JSONC)!);
    expect(mcp.servers.transversals).toEqual(DESIRED_ENTRY);
    expect(mcp.transversals).toBeUndefined();
  });

  it("writes mcp.transversals next to existing servers when there is no mcp.servers", async () => {
    const original = `${JSON.stringify({ mcp: { other: OTHER_ENTRY } }, null, 2)}\n`;
    const h = harness({ files: { [OPENCODE_JSON]: original } });

    await h.run("register", "--client", "opencode");

    const mcp = mcpOf(h.fs.files.get(OPENCODE_JSON)!);
    expect(mcp.transversals).toEqual(DESIRED_ENTRY);
    expect(mcp.other).toEqual(OTHER_ENTRY);
    expect(mcp.servers).toBeUndefined();
  });

  it("creates mcp when it is absent", async () => {
    const h = harness({ files: { [OPENCODE_JSON]: '{\n  "theme": "dark"\n}\n' } });

    await h.run("register", "--client", "opencode");

    const parsed = parseStrictJsonc(h.fs.files.get(OPENCODE_JSON)!);
    expect(parsed).toEqual({ theme: "dark", mcp: { transversals: DESIRED_ENTRY } });
  });

  it("replaces an outdated transversals entry", async () => {
    const original = `${JSON.stringify(
      { mcp: { transversals: { type: "local", command: ["npx", "tsx", "src/index.ts"], enabled: false } } },
      null,
      2,
    )}\n`;
    const h = harness({ files: { [OPENCODE_JSON]: original } });

    await h.run("register", "--client", "opencode");

    expect(mcpOf(h.fs.files.get(OPENCODE_JSON)!).transversals).toEqual(DESIRED_ENTRY);
  });
});

// ---------------------------------------------------------------------------
// C5b-5 JSONC preservation

describe("C5b-5 JSONC preservation", () => {
  it("keeps comments, trailing commas and text outside the entry byte-for-byte", async () => {
    const before = SERVERS_LAYOUT_JSONC;
    const h = harness({ files: { [OPENCODE_JSONC]: before } });

    const code = await h.run("register", "--client", "opencode");

    expect(code).toBe(0);
    const after = h.fs.files.get(OPENCODE_JSONC)!;
    for (const comment of [
      "// my OpenCode config",
      "/* MCP servers live under mcp.servers */",
      "// keep me",
      "/* trailing comment */",
    ]) {
      expect(after).toContain(comment);
    }
    expect(after).toContain(OTHER_PROPERTY_TEXT);
    // Everything before the servers' first member, and everything from mcp's closing brace on.
    expect(after.startsWith(before.slice(0, before.indexOf('"other"')))).toBe(true);
    expect(after.endsWith(before.slice(before.indexOf('\n  },\n  "theme"')))).toBe(true);
    expect(mcpOf(after).servers.other).toEqual(mcpOf(before).servers.other);
    expect(parseStrictJsonc(after).theme).toBe("dark");
  });
});

// ---------------------------------------------------------------------------
// C5b-6 backup, idempotency and malformed input

describe("C5b-6 OpenCode backup and idempotency", () => {
  it("writes the original content to <file>.transversals-backup before modifying", async () => {
    const h = harness({ files: { [OPENCODE_JSONC]: SERVERS_LAYOUT_JSONC } });

    await h.run("register", "--client", "opencode");

    expect(h.fs.files.get(`${OPENCODE_JSONC}${BACKUP_SUFFIX}`)).toBe(SERVERS_LAYOUT_JSONC);
    const order = h.events.filter((event) => event.startsWith("write "));
    expect(order.indexOf(`write ${OPENCODE_JSONC}${BACKUP_SUFFIX}`)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(`write ${OPENCODE_JSONC}${BACKUP_SUFFIX}`)).toBeLessThan(
      order.indexOf(`write ${OPENCODE_JSONC}`),
    );
  });

  it("writes nothing (no backup) when the entry is already up to date", async () => {
    const current = `${JSON.stringify(
      { mcp: { servers: { other: OTHER_ENTRY, transversals: DESIRED_ENTRY } } },
      null,
      2,
    )}\n`;
    const h = harness({ files: { [OPENCODE_JSON]: current } });

    const code = await h.run("register", "--client", "opencode");

    expect(code).toBe(0);
    expect(h.fs.writeFile).not.toHaveBeenCalled();
    expect(h.fs.files.get(OPENCODE_JSON)).toBe(current);
  });

  it("fails that client, leaves malformed JSONC untouched and writes no backup", async () => {
    const malformed = '{\n  "mcp": { "servers": {\n';
    const h = harness({ files: { [OPENCODE_JSONC]: malformed } });

    const code = await h.run("register", "--client", "opencode");

    expect(code).not.toBe(0);
    expect(h.fs.writeFile).not.toHaveBeenCalled();
    expect(h.fs.files.get(OPENCODE_JSONC)).toBe(malformed);
  });
});

// ---------------------------------------------------------------------------
// C5b-7 setup registers afterwards

describe("C5b-7 setup registration hook", () => {
  it("registers with detected clients after the config is saved", async () => {
    const h = harness({ files: { [OPENCODE_JSON]: "{}\n" } });

    const code = await h.run("setup", "--vm", VM_NAME);

    expect(code).toBe(0);
    const configSaved = h.events.indexOf(`write ${CONFIG_PATH}`);
    const claudeAdd = h.events.indexOf(`claude ${CLAUDE_ADD.join(" ")}`);
    const opencodeWrite = h.events.indexOf(`write ${OPENCODE_JSON}`);
    expect(configSaved).toBeGreaterThanOrEqual(0);
    expect(claudeAdd).toBeGreaterThan(configSaved);
    expect(opencodeWrite).toBeGreaterThan(configSaved);
    expect(mcpOf(h.fs.files.get(OPENCODE_JSON)!).transversals).toEqual(DESIRED_ENTRY);
  });

  it("`setup --no-register` skips registration", async () => {
    const h = harness({ files: { [OPENCODE_JSON]: "{}\n" } });

    const code = await h.run("setup", "--vm", VM_NAME, "--no-register");

    expect(code).toBe(0);
    expect(h.savedConfig()).toEqual(COMPLETE_CONFIG);
    expect(h.prlctl.claudeCalls()).toEqual([]);
    expect(h.fs.files.get(OPENCODE_JSON)).toBe("{}\n");
  });

  it("exits non-zero when registration fails but keeps the saved config", async () => {
    const h = harness({
      prlctl: { claude: { addReject: Object.assign(new Error("Command failed: claude mcp add"), { code: 1 }) } },
    });

    const code = await h.run("setup", "--vm", VM_NAME);

    expect(code).not.toBe(0);
    expect(h.prlctl.claudeCalls()).toContainEqual(CLAUDE_ADD);
    expect(h.savedConfig()).toEqual(COMPLETE_CONFIG);
  });
});

// ---------------------------------------------------------------------------
// C5b-8 uninstall

const SERVERS_WITH_TRANSVERSALS = `${JSON.stringify(
  { mcp: { servers: { other: OTHER_ENTRY, transversals: DESIRED_ENTRY } } },
  null,
  2,
)}\n`;

function uninstallHarness(options: Parameters<typeof harness>[0] = {}) {
  return harness({
    files: { ...configFile(COMPLETE_CONFIG), [OPENCODE_JSON]: SERVERS_WITH_TRANSVERSALS },
    ...options,
    prlctl: {
      snapshots: [
        { id: FOREIGN_SNAPSHOT_ID, name: "vm-operator-baseline" },
        { id: OWNED_SNAPSHOT_ID, name: "transversals-baseline" },
      ],
      copy: { stdout: "" },
      ...options.prlctl,
    },
  });
}

function expectNoVmMutationBesidesGuestCleanup(h: ReturnType<typeof harness>): void {
  const forbidden = h.prlctl
    .calls()
    .filter((args) => MUTATING_PRLCTL.has(args[0]!) && args[0] !== "snapshot-delete");
  expect(forbidden).toEqual([]);
}

describe("C5b-8 `transversals uninstall`", () => {
  it("removes the Claude registration, the OpenCode entry, the guest install and the config dir", async () => {
    const h = uninstallHarness();

    const code = await h.run("uninstall");

    expect(code).toBe(0);
    expect(h.prlctl.claudeCalls()).toEqual([CLAUDE_REMOVE]);

    const mcp = mcpOf(h.fs.files.get(OPENCODE_JSON)!);
    expect(mcp.servers.transversals).toBeUndefined();
    expect(mcp.servers.other).toEqual(OTHER_ENTRY);
    expect(h.fs.files.get(`${OPENCODE_JSON}${BACKUP_SUFFIX}`)).toBe(SERVERS_WITH_TRANSVERSALS);

    const guest = h.prlctl.calls().filter(isGuestPowerShell);
    expect(guest).toHaveLength(1);
    expect(guest[0]!.slice(0, 3)).toEqual(["exec", VM_ID, "--current-user"]);
    const script = guest[0]!.slice(3).join(" ");
    expect(script).toContain("LOCALAPPDATA");
    expect(script).toContain("transversals");

    expect(h.fs.removePath.mock.calls.map(([path]) => path)).toEqual([CONFIG_DIR]);
    expectNoVmMutationBesidesGuestCleanup(h);
  });

  it("removes an entry stored at mcp.transversals", async () => {
    const original = `${JSON.stringify({ mcp: { other: OTHER_ENTRY, transversals: DESIRED_ENTRY } }, null, 2)}\n`;
    const h = uninstallHarness({ files: { ...configFile(COMPLETE_CONFIG), [OPENCODE_JSON]: original } });

    await h.run("uninstall");

    const mcp = mcpOf(h.fs.files.get(OPENCODE_JSON)!);
    expect(mcp.transversals).toBeUndefined();
    expect(mcp.other).toEqual(OTHER_ENTRY);
  });

  it("does not write OpenCode config (or a backup) when there is no entry", async () => {
    const original = `${JSON.stringify({ mcp: { servers: { other: OTHER_ENTRY } } }, null, 2)}\n`;
    const h = uninstallHarness({ files: { ...configFile(COMPLETE_CONFIG), [OPENCODE_JSON]: original } });

    await h.run("uninstall");

    expect(h.fs.writeFile).not.toHaveBeenCalled();
    expect(h.fs.files.get(OPENCODE_JSON)).toBe(original);
  });

  it("tolerates Claude Code having no registration", async () => {
    const h = uninstallHarness({
      prlctl: {
        claude: {
          removeReject: Object.assign(new Error("Command failed: claude mcp remove -s user transversals"), {
            code: 1,
            stderr: "No MCP server found with name: transversals\n",
          }),
        },
      },
    });

    const code = await h.run("uninstall");

    expect(code).toBe(0);
    expect(h.fs.removePath.mock.calls.map(([path]) => path)).toEqual([CONFIG_DIR]);
  });

  it("tolerates Claude Code not being installed", async () => {
    const h = uninstallHarness({ prlctl: { claude: { missing: true } } });

    const code = await h.run("uninstall");

    expect(code).toBe(0);
    expect(h.fs.removePath.mock.calls.map(([path]) => path)).toEqual([CONFIG_DIR]);
  });

  it("skips the guest cleanup when no vmId is configured", async () => {
    const h = uninstallHarness({ files: { [OPENCODE_JSON]: SERVERS_WITH_TRANSVERSALS } });

    await h.run("uninstall");

    expect(h.prlctl.calls().filter((args) => args[0] === "exec")).toEqual([]);
    expect(h.fs.removePath.mock.calls.map(([path]) => path)).toEqual([CONFIG_DIR]);
  });

  it("skips the guest cleanup when the VM is not running, and never starts it", async () => {
    const h = uninstallHarness({ prlctl: { vms: [{ uuid: VM_ID, name: VM_NAME, status: "stopped" }] } });

    await h.run("uninstall");

    expect(h.prlctl.calls().filter((args) => args[0] === "exec")).toEqual([]);
    expectNoVmMutationBesidesGuestCleanup(h);
    expect(h.fs.removePath.mock.calls.map(([path]) => path)).toEqual([CONFIG_DIR]);
  });

  it("warns and continues when the guest cleanup fails", async () => {
    const h = uninstallHarness({
      prlctl: { copy: { reject: Object.assign(new Error("Command failed: prlctl exec"), { code: 1 }) } },
    });

    await h.run("uninstall");

    expect(h.output()).toMatch(/warn/i);
    expect(h.fs.removePath.mock.calls.map(([path]) => path)).toEqual([CONFIG_DIR]);
  });
});

// ---------------------------------------------------------------------------
// C5b-9 uninstall snapshot prompt (default No)

function snapshotDeletes(h: ReturnType<typeof harness>): string[][] {
  return h.prlctl.calls().filter((args) => args[0] === "snapshot-delete");
}

describe("C5b-9 uninstall snapshot prompt", () => {
  it("asks whether to delete the transversals-baseline snapshot", async () => {
    const h = uninstallHarness();

    await h.run("uninstall");

    expect(h.prompt).toHaveBeenCalledWith(
      expect.stringContaining("Delete the transversals-baseline snapshot?"),
    );
  });

  it.each(["", "n", "N", "no", "maybe", " "])("does not delete for answer %j", async (answer) => {
    const h = uninstallHarness({ answer });

    await h.run("uninstall");

    expect(snapshotDeletes(h)).toEqual([]);
  });

  it.each(["y", "Y", "yes", "Yes"])("deletes only the owned snapshot by id for answer %j", async (answer) => {
    const h = uninstallHarness({ answer });

    const code = await h.run("uninstall");

    expect(code).toBe(0);
    const deletes = snapshotDeletes(h);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.slice(0, 3)).toEqual(["snapshot-delete", VM_ID, "--id"]);
    expect(deletes[0]![3]!.replace(/[{}]/g, "").toLowerCase()).toBe(OWNED_SNAPSHOT_ID);
    expect(deletes.flat().join(" ")).not.toContain(FOREIGN_SNAPSHOT_ID);
    expect(h.prlctl.calls().filter(isSnapshotList).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// C5b-10 package removal instructions and help

describe("C5b-10 uninstall package instructions and help", () => {
  it("prints the package removal commands verbatim and never runs them", async () => {
    const h = uninstallHarness();

    await h.run("uninstall");

    for (const command of UNINSTALL_PACKAGE_COMMANDS) {
      expect(h.output()).toContain(command);
    }
    const executables = h.prlctl.executables();
    expect(executables.filter((executable) => !["prlctl", "claude"].includes(executable))).toEqual([]);
    const everyArg = h.prlctl.runCommand.mock.calls.flatMap(([, args]) => args).join(" ");
    expect(everyArg).not.toMatch(/pkgutil|\/usr\/local/);
    for (const [path] of h.fs.removePath.mock.calls) {
      expect(path).not.toMatch(/^\/usr\/local/);
    }
  });

  it("--help lists register and uninstall", async () => {
    const h = harness();

    const code = await h.run("--help");

    expect(code).toBe(0);
    expect(h.output()).toContain("register");
    expect(h.output()).toContain("uninstall");
  });
});

// ---------------------------------------------------------------------------
// C5b-11 OpenCode config honours an absolute XDG_CONFIG_HOME

describe("C5b-11 OpenCode config under XDG_CONFIG_HOME", () => {
  it("uses $XDG_CONFIG_HOME/opencode when XDG_CONFIG_HOME is absolute", async () => {
    const xdgJsonc = "/xdg/opencode/opencode.jsonc";
    const h = harness({
      env: { XDG_CONFIG_HOME: "/xdg" },
      files: { [xdgJsonc]: "{}\n", [OPENCODE_JSONC]: "{}\n" },
    });

    const code = await h.run("register", "--client", "opencode");

    expect(code).toBe(0);
    expect(mcpOf(h.fs.files.get(xdgJsonc)!).transversals).toEqual(DESIRED_ENTRY);
    expect(h.fs.files.get(OPENCODE_JSONC)).toBe("{}\n");
    const written = h.fs.writeFile.mock.calls.map(([path]) => path);
    expect(written.filter((path) => path.startsWith(`${HOME}/.config/`))).toEqual([]);
  });

  it("ignores a relative XDG_CONFIG_HOME and uses <home>/.config/opencode", async () => {
    const relativeJsonc = "xdg/opencode/opencode.jsonc";
    const h = harness({
      env: { XDG_CONFIG_HOME: "xdg" },
      files: { [relativeJsonc]: "{}\n", [OPENCODE_JSONC]: "{}\n" },
    });

    const code = await h.run("register", "--client", "opencode");

    expect(code).toBe(0);
    expect(mcpOf(h.fs.files.get(OPENCODE_JSONC)!).transversals).toEqual(DESIRED_ENTRY);
    expect(h.fs.files.get(relativeJsonc)).toBe("{}\n");
    const written = h.fs.writeFile.mock.calls.map(([path]) => path);
    expect(written.filter((path) => !path.startsWith(`${HOME}/.config/opencode/`))).toEqual([]);
  });
});

// ===========================================================================
// Center review fixes (R-3, R-8, R-9)

describe("R-3 setup warns that an existing baseline predates the new agent", () => {
  it("explains the kept baseline still has the old agent and how to refresh it, exiting 0", async () => {
    const h = harness({
      prlctl: { snapshots: [{ id: OWNED_SNAPSHOT_ID, name: "transversals-baseline" }] },
    });

    const code = await h.run("setup", "--vm", VM_NAME, "--no-register");

    expect(code).toBe(0);
    expect(h.prlctl.calls().filter(isSnapshotCreate)).toEqual([]);
    expect(h.output()).toContain("transversals-baseline");
    expect(h.output()).toMatch(/refresh/i);
    expect(h.output()).toMatch(/agent/i);
  });
});

describe("R-8 uninstall prompt reports the baseline count", () => {
  it("includes the count when two baseline snapshots exist", async () => {
    const h = uninstallHarness({
      prlctl: {
        snapshots: [
          { id: OWNED_SNAPSHOT_ID, name: "transversals-baseline" },
          { id: SECOND_OWNED_SNAPSHOT_ID, name: "transversals-baseline" },
        ],
      },
    });

    await h.run("uninstall");

    expect(h.prompt).toHaveBeenCalledTimes(1);
    const question = h.prompt.mock.calls[0]![0];
    expect(question).toContain("transversals-baseline");
    expect(question).toContain("2");
  });

  it("keeps the single-snapshot question when one exists", async () => {
    const h = uninstallHarness();

    await h.run("uninstall");

    expect(h.prompt).toHaveBeenCalledWith(
      expect.stringContaining("Delete the transversals-baseline snapshot?"),
    );
  });
});

describe("R-9 register backup and Claude failure messaging", () => {
  it("does not overwrite an existing backup", async () => {
    const outdated = `${JSON.stringify(
      { mcp: { transversals: { type: "local", command: ["old", "serve"], enabled: true } } },
      null,
      2,
    )}\n`;
    const backupPath = `${OPENCODE_JSON}${BACKUP_SUFFIX}`;
    const h = harness({ files: { [OPENCODE_JSON]: outdated, [backupPath]: "FIRST BACKUP\n" } });

    const code = await h.run("register", "--client", "opencode");

    expect(code).toBe(0);
    expect(mcpOf(h.fs.files.get(OPENCODE_JSON)!).transversals).toEqual(DESIRED_ENTRY);
    expect(h.fs.files.get(backupPath)).toBe("FIRST BACKUP\n");
    expect(h.fs.writeFile.mock.calls.map(([path]) => path)).not.toContain(backupPath);
  });

  it("keeps the first backup across two changing registers", async () => {
    const original = '{\n  "theme": "dark"\n}\n';
    const backupPath = `${OPENCODE_JSON}${BACKUP_SUFFIX}`;
    const h = harness({ files: { [OPENCODE_JSON]: original } });

    await h.run("register", "--client", "opencode");
    h.deps.serveCommand = ["/opt/transversals/bin/transversals", "serve"];
    await h.run("register", "--client", "opencode");

    expect(mcpOf(h.fs.files.get(OPENCODE_JSON)!).transversals.command).toEqual([
      "/opt/transversals/bin/transversals",
      "serve",
    ]);
    expect(h.fs.files.get(backupPath)).toBe(original);
  });

  it("says the previous registration was removed when `claude mcp add` fails", async () => {
    const h = harness({
      prlctl: { claude: { addReject: Object.assign(new Error("Command failed: claude mcp add"), { code: 1 }) } },
    });

    const code = await h.run("register", "--client", "claude");

    expect(code).not.toBe(0);
    expect(h.output()).toMatch(/previous/i);
    expect(h.output()).toMatch(/removed/i);
  });
});

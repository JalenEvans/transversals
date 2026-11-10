#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  defaultRunCommand,
  normalizeConfiguredUuid,
  OperatorError,
  OWNED_SNAPSHOT_NAME,
  parseOwnedSnapshotIds,
  runPrlctl,
  startStdioServer,
  type PrlctlRequest,
  type RunCommand,
} from "./index.js";
import {
  OpenCodeConfigError,
  removeOpenCodeServer,
  upsertOpenCodeServer,
  type OpenCodeEdit,
} from "./opencode-config.js";
import {
  SemanticAgentClient,
  type SpawnImplementation,
} from "./semantic-agent-client.js";
import { relayStream, type SignalSubscriber, type StreamSink } from "./stream.js";

export type CliConfig = { vmId: string; agentExecutable: string };

export type CliDeps = {
  /** Runs every prlctl call (never through a shell). */
  runCommand: RunCommand;
  /** Spawns the `prlctl exec <vm> --current-user <agent>` relay for hello checks. */
  spawnProcess: SpawnImplementation;
  env: NodeJS.ProcessEnv;
  homedir: string;
  /** Package directory containing package.json and dist/guest/win-arm64. */
  packageRoot: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Rejects with `code: "ENOENT"` when the file is missing. */
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
  /** Starts the MCP stdio server; resolves once it is serving. */
  startServer: (config: CliConfig) => Promise<void>;
  /** Absolute argv MCP clients should launch, e.g. ["/usr/local/bin/transversals", "serve"]. */
  serveCommand: readonly string[];
  /** Asks the user a question; resolves "" when non-interactive. */
  prompt: (question: string) => Promise<string>;
  /** Removes a file or directory recursively; succeeds when it is already gone. */
  removePath: (path: string) => Promise<void>;
  /** Binary output for `stream` (process.stdout); a closed consumer surfaces as an "error" event. */
  streamOut: StreamSink;
  /** Subscribes to SIGINT/SIGTERM; returns the unsubscribe function. */
  onSignal: SignalSubscriber;
};

const SHARE_NAME = "transversals-provision";
const SERVER_NAME = "transversals";
const CLAUDE_TIMEOUT_MS = 60_000;
const CLIENTS = ["claude", "opencode"] as const;
type Client = (typeof CLIENTS)[number];
const BACKUP_SUFFIX = ".transversals-backup";
/** Printed verbatim by `uninstall`; never executed. */
const PACKAGE_REMOVAL_COMMANDS = [
  "sudo rm -rf /usr/local/lib/transversals /usr/local/bin/transversals",
  "sudo pkgutil --forget io.github.jalenevans.transversals",
];
const AGENT_EXE = "Transversals.GuestAgent.exe";
const COPY_TIMEOUT_MS = 5 * 60_000;
const SNAPSHOT_TIMEOUT_MS = 10 * 60_000;
const CONFIG_KEYS = ["vmId", "agentExecutable"] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

const ENV_KEYS: Record<ConfigKey, string> = {
  vmId: "TRANSVERSALS_VM_ID",
  agentExecutable: "TRANSVERSALS_UI_AGENT_EXECUTABLE",
};

const USAGE = `Usage: transversals <command>

Commands:
  serve                         Run the MCP server on stdio (for MCP clients)
  setup [--vm <name|uuid>] [--no-register]
                                Install the guest agent into a running Parallels VM,
                                save config, create the "${OWNED_SNAPSHOT_NAME}" snapshot,
                                and register with Claude Code / OpenCode
  register [--client claude|opencode]
                                Register the MCP server with Claude Code and/or OpenCode
  doctor                        Check the VM, Parallels Tools, guest agent and snapshot
  stream [--fps 1-30] [--max-size 320-1920] [--quality 30-95] [--vm <name|uuid>]
                                Write the VM screen to stdout as MJPEG (defaults: 15 fps,
                                800 px long edge, quality 70), e.g. | ffplay -f mjpeg -
  config [show]                 Print the effective config (env overrides the file)
  config set <key> <value>      Save vmId or agentExecutable to the config file
  uninstall                     Unregister, remove the guest agent and config, and print
                                the commands that remove the package itself

Options:
  -h, --help                    Show this help
  -V, --version                 Print the version
`;

// The guest copy runs through `prlctl exec ... powershell.exe -Command <script>`.
// It deliberately avoids double quotes and cmd metacharacters (| & < > ^) so it
// survives however prlctl re-joins the arguments into a Windows command line.
// On success the resolved destination path is the only line written to stdout;
// failures print a TRANSVERSALS_ERROR marker and exit non-zero.
// The exe is copied first (a running agent locks it, so that is where destination-locked shows up),
// then the share's other files (the WPF native DLLs, shipped beside the exe). Old builds
// with only the exe on the share copy just the exe.
// Each copy's catch block: access denied or a sharing/lock violation means the destination is in use.
const GUEST_COPY_CATCH =
  "catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; if ($e -is [System.UnauthorizedAccessException] -or $e.HResult -eq -2147024864 -or $e.HResult -eq -2147024863) { [Console]::Out.WriteLine('TRANSVERSALS_ERROR destination-locked') } else { [Console]::Out.WriteLine('TRANSVERSALS_ERROR copy-failed ' + $e.Message) }; exit 3 }";
const GUEST_COPY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `$srcDir = '\\\\Mac\\${SHARE_NAME}\\'`,
  `$src = '\\\\Mac\\${SHARE_NAME}\\${AGENT_EXE}'`,
  "$tries = 0",
  "while (-not (Test-Path -LiteralPath $src) -and $tries -lt 15) { Start-Sleep -Seconds 1; $tries++ }",
  "if (-not (Test-Path -LiteralPath $src)) { [Console]::Out.WriteLine('TRANSVERSALS_ERROR source-missing'); exit 2 }",
  "$dir = Join-Path $env:LOCALAPPDATA 'transversals\\agent'",
  "$null = New-Item -ItemType Directory -Force -Path $dir",
  `$dst = Join-Path $dir '${AGENT_EXE}'`,
  `try { Copy-Item -LiteralPath $src -Destination $dst -Force } ${GUEST_COPY_CATCH}`,
  `foreach ($f in Get-ChildItem -LiteralPath $srcDir -File) { if ($f.Name -ne '${AGENT_EXE}') { try { Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $dir $f.Name) -Force } ${GUEST_COPY_CATCH} } }`,
  "[Console]::Out.WriteLine((Resolve-Path -LiteralPath $dst).ProviderPath)",
].join("; ");

// Removes %LOCALAPPDATA%\transversals from the guest. Same quoting constraints as above.
const GUEST_REMOVE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$dir = Join-Path $env:LOCALAPPDATA 'transversals'",
  "if (-not (Test-Path -LiteralPath $dir)) { [Console]::Out.WriteLine('absent'); exit 0 }",
  "try { Remove-Item -LiteralPath $dir -Recurse -Force } catch { [Console]::Out.WriteLine('TRANSVERSALS_ERROR remove-failed ' + $_.Exception.Message); exit 3 }",
  "[Console]::Out.WriteLine('removed')",
].join("; ");

function powershell(script: string): string[] {
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ];
}

/** A user-facing failure: printed to stderr as-is, exit code 1 (or `exitCode`). */
class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

type FileConfig = Partial<Record<ConfigKey, string>> & Record<string, unknown>;
type VmEntry = { uuid: string; name: string; status: string };

function configPath(deps: CliDeps): { dir: string; file: string } {
  const dir = join(deps.homedir, "Library", "Application Support", "transversals");
  return { dir, file: join(dir, "config.json") };
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? "";
}

/** Short, human-readable reason for a failed prlctl/agent call. */
function describeError(error: unknown): string {
  const cause = error instanceof OperatorError ? error.cause : undefined;
  const stderr =
    typeof cause === "object" && cause !== null
      ? (cause as { stderr?: unknown }).stderr
      : undefined;
  if (typeof stderr === "string" && stderr.trim().length > 0) return firstLine(stderr);
  return firstLine(error instanceof Error ? error.message : String(error)) || "unknown error";
}

async function readFileConfig(deps: CliDeps): Promise<FileConfig> {
  const { file } = configPath(deps);
  let raw: string;
  try {
    raw = await deps.readFile(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw new CliError(`Could not read ${file}: ${describeError(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`${file} is not valid JSON. Fix it or delete it and run \`transversals setup\`.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${file} must contain a JSON object.`);
  }
  const config = parsed as Record<string, unknown>;
  for (const key of CONFIG_KEYS) {
    if (config[key] !== undefined && typeof config[key] !== "string") {
      throw new CliError(`${file}: "${key}" must be a string.`);
    }
  }
  return config as FileConfig;
}

async function writeFileConfig(deps: CliDeps, config: FileConfig): Promise<string> {
  const { dir, file } = configPath(deps);
  await deps.mkdir(dir, { recursive: true });
  await deps.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

/** File values with non-empty env vars layered on top. */
async function effectiveConfig(deps: CliDeps): Promise<Partial<CliConfig>> {
  const file = await readFileConfig(deps);
  const result: Partial<CliConfig> = {};
  for (const key of CONFIG_KEYS) {
    const fromEnv = deps.env[ENV_KEYS[key]];
    const value = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : file[key];
    if (value !== undefined && value.trim().length > 0) result[key] = value;
  }
  return result;
}

/** Complete, validated config, or a CliError pointing at `transversals setup`. */
async function requireConfig(deps: CliDeps): Promise<CliConfig> {
  const config = await effectiveConfig(deps);
  const missing = CONFIG_KEYS.filter((key) => config[key] === undefined);
  if (missing.length > 0) {
    throw new CliError(
      `Not configured (missing ${missing.join(", ")}). Run \`transversals setup\` first.`,
    );
  }
  let vmId: string;
  try {
    vmId = normalizeConfiguredUuid(config.vmId, "vmId");
  } catch {
    throw new CliError(
      `Configured vmId "${config.vmId}" is not a VM UUID. Run \`transversals setup\` or \`transversals config set vmId <uuid>\`.`,
    );
  }
  return { vmId, agentExecutable: config.agentExecutable! };
}

function prlctl(
  deps: CliDeps,
  request: PrlctlRequest,
  timeoutMs?: number,
): Promise<string> {
  return runPrlctl(deps.runCommand, request, timeoutMs === undefined ? {} : { timeoutMs });
}

async function listVms(deps: CliDeps): Promise<VmEntry[]> {
  let raw: string;
  try {
    raw = await prlctl(deps, { operation: "list-all" });
  } catch (error) {
    throw new CliError(
      `Could not list Parallels VMs (is Parallels Desktop installed?): ${describeError(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? [] : JSON.parse(raw);
  } catch {
    throw new CliError("`prlctl list -a -j` returned unparseable output.");
  }
  if (!Array.isArray(parsed)) {
    throw new CliError("`prlctl list -a -j` returned an unexpected shape.");
  }
  const vms: VmEntry[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { uuid, name, status } = entry as Record<string, unknown>;
    if (typeof uuid !== "string" || typeof name !== "string") continue;
    try {
      vms.push({
        uuid: normalizeConfiguredUuid(uuid, "uuid"),
        name,
        status: typeof status === "string" ? status : "unknown",
      });
    } catch {
      // Skip entries whose id is not a UUID; they cannot be targeted safely.
    }
  }
  return vms;
}

function formatVmNames(vms: readonly VmEntry[]): string {
  return vms.map((vm) => `  ${vm.name}  (${vm.uuid}, ${vm.status})`).join("\n");
}

function resolveVm(vms: readonly VmEntry[], selector: string | undefined): VmEntry {
  if (selector === undefined) {
    if (vms.length === 1) return vms[0]!;
    if (vms.length === 0) throw new CliError("No Parallels VMs found. Create a Windows VM first.");
    throw new CliError(
      `Several VMs found; choose one with --vm <name|uuid>:\n${formatVmNames(vms)}`,
    );
  }

  let uuid: string | undefined;
  try {
    uuid = normalizeConfiguredUuid(selector, "--vm");
  } catch {
    uuid = undefined;
  }
  const matches = vms.filter((vm) => (uuid !== undefined ? vm.uuid === uuid : vm.name === selector));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new CliError(
      `No VM matches --vm "${selector}". Available VMs:\n${formatVmNames(vms) || "  (none)"}`,
    );
  }
  throw new CliError(
    `Several VMs are named "${selector}"; pass the uuid with --vm instead:\n${formatVmNames(matches)}`,
  );
}

type AgentHello = {
  /** The agent's version, or "unknown" when missing, empty or not a string. */
  version: string;
  /** False when hello has no missingNativeFiles field (older agents). */
  reportsNativeFiles: boolean;
  /** The raw missingNativeFiles value, unvalidated. */
  missingNativeFiles?: unknown;
};

/** Says hello to the agent at `agentExecutable`; returns the reported version and native-file report. */
async function helloAgent(deps: CliDeps, vmId: string, agentExecutable: string): Promise<AgentHello> {
  const client = new SemanticAgentClient(vmId, agentExecutable, deps.spawnProcess);
  try {
    const [hello] = await client.send([{ type: "hello" }]);
    const fields: Record<string, unknown> = typeof hello === "object" && hello !== null ? { ...hello } : {};
    const version = fields.agentVersion;
    return {
      version: typeof version === "string" && version.length > 0 ? version : "unknown",
      reportsNativeFiles: "missingNativeFiles" in fields,
      missingNativeFiles: fields.missingNativeFiles,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function ownedSnapshotIds(deps: CliDeps, vmId: string): Promise<string[]> {
  const raw = await prlctl(deps, { operation: "snapshot-list", vmId });
  return parseOwnedSnapshotIds(raw).map((id) => normalizeConfiguredUuid(id, "snapshot id"));
}

// ---------------------------------------------------------------------------
// Commands

async function commandConfig(args: readonly string[], deps: CliDeps): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || (sub === "show" && rest.length === 0)) {
    deps.stdout(`${JSON.stringify(await effectiveConfig(deps), null, 2)}\n`);
    return 0;
  }
  if (sub !== "set" || rest.length !== 2) {
    throw new CliError(`Usage: transversals config [show] | config set <${CONFIG_KEYS.join("|")}> <value>`, 2);
  }

  const [key, rawValue] = rest as [string, string];
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new CliError(`Unknown config key "${key}". Valid keys: ${CONFIG_KEYS.join(", ")}.`, 2);
  }
  let value = rawValue.trim();
  if (key === "vmId") {
    try {
      value = normalizeConfiguredUuid(value, "vmId");
    } catch {
      throw new CliError(`"${rawValue}" is not a VM UUID. Find it with \`prlctl list -a\`.`);
    }
  } else if (value.length === 0) {
    throw new CliError(`${key} must not be empty.`);
  }

  const config = await readFileConfig(deps);
  const file = await writeFileConfig(deps, { ...config, [key]: value });
  deps.stdout(`Saved ${key} to ${file}\n`);
  return 0;
}

async function commandServe(args: readonly string[], deps: CliDeps): Promise<number> {
  if (args.length > 0) throw new CliError(`serve takes no arguments.\n\n${USAGE}`, 2);
  // stdout belongs to the MCP protocol from here on: errors go to stderr only.
  const config = await requireConfig(deps);
  try {
    await deps.startServer(config);
  } catch (error) {
    throw new CliError(`Could not start the MCP server: ${describeError(error)}`);
  }
  return 0;
}

function parseSetupArgs(args: readonly string[]): { vm?: string; register: boolean } {
  let vm: string | undefined;
  let register = true;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--no-register") {
      register = false;
    } else if (arg === "--vm") {
      const value = args[++index];
      if (value === undefined || value.length === 0) throw new CliError("--vm needs a VM name or uuid.", 2);
      vm = value;
    } else if (arg.startsWith("--vm=")) {
      vm = arg.slice("--vm=".length);
      if (vm.length === 0) throw new CliError("--vm needs a VM name or uuid.", 2);
    } else {
      throw new CliError(`Unknown setup option "${arg}".\n\n${USAGE}`, 2);
    }
  }
  return vm === undefined ? { register } : { vm, register };
}

/** Copies the agent into the guest and returns the guest path it printed. */
async function copyAgentToGuest(deps: CliDeps, vmId: string): Promise<string> {
  let stdout: string;
  try {
    stdout = await prlctl(
      deps,
      {
        operation: "exec",
        vmId,
        command: powershell(GUEST_COPY_SCRIPT),
      },
      COPY_TIMEOUT_MS,
    );
  } catch (error) {
    const cause = error instanceof OperatorError ? error.cause : undefined;
    const causeStdout =
      typeof cause === "object" && cause !== null
        ? (cause as { stdout?: unknown }).stdout
        : undefined;
    throw copyFailure(typeof causeStdout === "string" ? causeStdout : "", error, vmId);
  }

  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.some((line) => line.startsWith("TRANSVERSALS_ERROR"))) {
    throw copyFailure(stdout, undefined, vmId);
  }
  const path = lines.at(-1);
  if (path === undefined || !/^[A-Za-z]:\\.+\\Transversals\.GuestAgent\.exe$/i.test(path)) {
    throw new CliError(
      `Guest copy returned unexpected output${path === undefined ? "" : `: ${path}`}. Is Parallels Tools running in the VM?`,
    );
  }
  return path;
}

function copyFailure(output: string, error: unknown, vmId: string): CliError {
  const marker = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("TRANSVERSALS_ERROR"));
  if (marker?.startsWith("TRANSVERSALS_ERROR source-missing")) {
    return new CliError(
      `The guest could not see \\\\Mac\\${SHARE_NAME}\\${AGENT_EXE}. Build the agent with \`npm run guest:publish\` and make sure Mac folder sharing is on (\`prlctl set ${vmId} --shf-host on\`).`,
    );
  }
  if (marker?.startsWith("TRANSVERSALS_ERROR destination-locked")) {
    return new CliError(
      "The installed guest agent is in use and could not be replaced. Close MCP sessions using transversals (or end Transversals.GuestAgent.exe in the guest), then rerun setup.",
    );
  }
  if (marker?.startsWith("TRANSVERSALS_ERROR copy-failed")) {
    return new CliError(
      `Copying the guest agent failed: ${marker.slice("TRANSVERSALS_ERROR copy-failed".length).trim()}`,
    );
  }
  return new CliError(
    `Could not run the guest copy (are Parallels Tools installed and is a user logged in?): ${describeError(error)}`,
  );
}

async function ensureOwnedSnapshot(deps: CliDeps, vmId: string): Promise<number> {
  const existing = await ownedSnapshotIds(deps, vmId);
  if (existing.length === 1) {
    deps.stdout(
      `Snapshot "${OWNED_SNAPSHOT_NAME}" already exists (${existing[0]}); left unchanged.\n` +
        `Note: it still holds the guest agent from when it was taken, so vm_restore brings that agent back. ` +
        `To refresh it with the agent just installed, delete the snapshot (Parallels Snapshot Manager, or ` +
        `\`prlctl snapshot-delete ${vmId} --id ${existing[0]}\`) and rerun setup.\n`,
    );
    return 0;
  }
  if (existing.length > 1) {
    deps.stderr(
      `Found ${existing.length} "${OWNED_SNAPSHOT_NAME}" snapshots; vm_restore needs exactly one. Delete the extras in Parallels (Snapshot Manager), then run \`transversals doctor\`.\n`,
    );
    return 1;
  }

  deps.stdout(`Creating snapshot "${OWNED_SNAPSHOT_NAME}" (this can take a few minutes)...\n`);
  try {
    await prlctl(
      deps,
      { operation: "snapshot-create", vmId, name: OWNED_SNAPSHOT_NAME },
      SNAPSHOT_TIMEOUT_MS,
    );
  } catch (error) {
    throw new CliError(`Creating snapshot "${OWNED_SNAPSHOT_NAME}" failed: ${describeError(error)}`);
  }
  const created = await ownedSnapshotIds(deps, vmId);
  if (created.length !== 1) {
    throw new CliError(
      `Snapshot "${OWNED_SNAPSHOT_NAME}" was not found after creating it (found ${created.length}). Check Parallels Snapshot Manager, then run \`transversals doctor\`.`,
    );
  }
  deps.stdout(`Created snapshot "${OWNED_SNAPSHOT_NAME}" (${created[0]}).\n`);
  return 0;
}

async function commandSetup(args: readonly string[], deps: CliDeps): Promise<number> {
  const options = parseSetupArgs(args);
  const vm = resolveVm(await listVms(deps), options.vm);
  if (vm.status !== "running") {
    throw new CliError(
      `VM "${vm.name}" is ${vm.status}. Start it (prlctl start ${vm.uuid}), log in to Windows, then rerun setup.`,
    );
  }
  deps.stdout(`Using VM "${vm.name}" (${vm.uuid}).\n`);

  const hostPath = join(deps.packageRoot, "dist", "guest", "win-arm64");
  try {
    await prlctl(deps, {
      operation: "share-add",
      vmId: vm.uuid,
      shareName: SHARE_NAME,
      hostPath,
      readOnly: true,
    });
  } catch (error) {
    throw new CliError(
      `Could not share ${hostPath} with the VM: ${describeError(error)}. If a stale share exists, remove it with \`prlctl set ${vm.uuid} --shf-host-del ${SHARE_NAME}\`.`,
    );
  }

  let agentExecutable: string;
  try {
    deps.stdout("Copying the guest agent into the VM...\n");
    agentExecutable = await copyAgentToGuest(deps, vm.uuid);
  } finally {
    try {
      await prlctl(deps, { operation: "share-remove", vmId: vm.uuid, shareName: SHARE_NAME });
    } catch (error) {
      deps.stderr(
        `Warning: could not remove the temporary share: ${describeError(error)}. Remove it with \`prlctl set ${vm.uuid} --shf-host-del ${SHARE_NAME}\`.\n`,
      );
    }
  }
  deps.stdout(`Installed ${agentExecutable}\n`);

  let version: string;
  try {
    ({ version } = await helloAgent(deps, vm.uuid, agentExecutable));
  } catch (error) {
    throw new CliError(
      `The installed guest agent did not respond: ${describeError(error)}. Make sure a user is logged in to Windows, then rerun setup.`,
    );
  }
  deps.stdout(`Guest agent ${version} responded.\n`);
  const hostVersion = await packageVersion(deps);
  if (version !== hostVersion) {
    deps.stderr(
      `Warning: the guest agent is ${version} but this host is ${hostVersion}; the bundled agent is stale. Rebuild it with \`npm run guest:publish\`, then rerun setup.\n`,
    );
  }

  const existing = await readFileConfig(deps);
  const file = await writeFileConfig(deps, { ...existing, vmId: vm.uuid, agentExecutable });
  deps.stdout(`Saved config to ${file}\n`);

  const snapshotCode = await ensureOwnedSnapshot(deps, vm.uuid);
  const registerCode = options.register ? await registerClients(deps, CLIENTS) : 0;
  if (snapshotCode !== 0 || registerCode !== 0) return 1;
  deps.stdout(
    options.register
      ? "Setup complete.\n"
      : "Setup complete. Run `transversals register` to add it to Claude Code / OpenCode.\n",
  );
  return 0;
}

// ---------------------------------------------------------------------------
// MCP client registration

type ClientOutcome = "changed" | "unchanged" | "skipped" | "failed";

function runClaude(deps: CliDeps, args: readonly string[]): Promise<unknown> {
  return deps.runCommand("claude", args, {
    shell: false,
    timeout: CLAUDE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
}

function rawErrorDetail(error: unknown): string {
  const stderr =
    typeof error === "object" && error !== null ? (error as { stderr?: unknown }).stderr : undefined;
  if (typeof stderr === "string" && stderr.trim().length > 0) return firstLine(stderr);
  return describeError(error);
}

const CLAUDE_NOT_FOUND = "Claude Code not found (`claude` is not on PATH); skipped.\n";

async function registerClaude(deps: CliDeps): Promise<ClientOutcome> {
  try {
    await runClaude(deps, ["mcp", "remove", "-s", "user", SERVER_NAME]);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      deps.stdout(CLAUDE_NOT_FOUND);
      return "skipped";
    }
    // Nothing registered yet; the add below is what matters.
  }
  try {
    await runClaude(deps, ["mcp", "add", "-s", "user", SERVER_NAME, "--", ...deps.serveCommand]);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      deps.stdout(CLAUDE_NOT_FOUND);
      return "skipped";
    }
    deps.stderr(
      `Claude Code: \`claude mcp add\` did not succeed: ${rawErrorDetail(error)}\n` +
        `Any previous "${SERVER_NAME}" registration was already removed, so Claude Code has none now. ` +
        `Fix the error above and rerun \`transversals register --client claude\`.\n`,
    );
    return "failed";
  }
  deps.stdout(`Claude Code: registered "${SERVER_NAME}" (user scope).\n`);
  return "changed";
}

async function unregisterClaude(deps: CliDeps): Promise<ClientOutcome> {
  try {
    await runClaude(deps, ["mcp", "remove", "-s", "user", SERVER_NAME]);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      deps.stdout(CLAUDE_NOT_FOUND);
      return "skipped";
    }
    const detail = rawErrorDetail(error);
    if (/no .*server found|not found/i.test(detail)) {
      deps.stdout(`Claude Code: no "${SERVER_NAME}" registration to remove.\n`);
      return "unchanged";
    }
    deps.stderr(`Warning: Claude Code: \`claude mcp remove\` did not succeed: ${detail}\n`);
    return "unchanged";
  }
  deps.stdout(`Claude Code: removed "${SERVER_NAME}".\n`);
  return "changed";
}

function openCodeDir(deps: CliDeps): string {
  const xdg = deps.env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg.startsWith("/") ? xdg : join(deps.homedir, ".config");
  return join(base, "opencode");
}

/** The OpenCode config file to edit (`opencode.jsonc` preferred), with its content. */
async function findOpenCodeConfig(
  deps: CliDeps,
): Promise<{ path: string; text: string } | { missing: string[] }> {
  const dir = openCodeDir(deps);
  const candidates = [join(dir, "opencode.jsonc"), join(dir, "opencode.json")];
  for (const path of candidates) {
    try {
      return { path, text: await deps.readFile(path) };
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new OpenCodeConfigError(`could not read ${path}: ${describeError(error)}`);
      }
    }
  }
  return { missing: candidates };
}

/** Applies a pure OpenCode text edit, backing up the original only when it changes. */
async function editOpenCode(
  deps: CliDeps,
  transform: (text: string) => OpenCodeEdit,
  messages: { changed: (path: string, location: string) => string; unchanged: (path: string) => string },
): Promise<ClientOutcome> {
  let found: Awaited<ReturnType<typeof findOpenCodeConfig>>;
  try {
    found = await findOpenCodeConfig(deps);
  } catch (error) {
    deps.stderr(`OpenCode: ${describeError(error)}\n`);
    return "failed";
  }
  if ("missing" in found) {
    deps.stdout(`OpenCode config not found (${found.missing.join(" or ")}); skipped.\n`);
    return "skipped";
  }

  let result: OpenCodeEdit;
  try {
    result = transform(found.text);
  } catch (error) {
    deps.stderr(`OpenCode: ${found.path} left untouched: ${describeError(error)}. Fix the file and rerun.\n`);
    return "failed";
  }
  if (result.status === "unchanged") {
    deps.stdout(messages.unchanged(found.path));
    return "unchanged";
  }

  // Keep the first backup: later runs would otherwise back up our own edits.
  const backup = `${found.path}${BACKUP_SUFFIX}`;
  try {
    let hasBackup = true;
    try {
      await deps.readFile(backup);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      hasBackup = false;
    }
    if (!hasBackup) await deps.writeFile(backup, found.text);
    await deps.writeFile(found.path, result.text);
  } catch (error) {
    deps.stderr(`OpenCode: could not write ${found.path}: ${describeError(error)}\n`);
    return "failed";
  }
  deps.stdout(`${messages.changed(found.path, result.location)} (backup: ${backup})\n`);
  return "changed";
}

function registerOpenCode(deps: CliDeps): Promise<ClientOutcome> {
  const entry = { type: "local", command: [...deps.serveCommand], enabled: true };
  return editOpenCode(deps, (text) => upsertOpenCodeServer(text, entry), {
    changed: (path, location) => `OpenCode: set ${location} in ${path}`,
    unchanged: (path) => `OpenCode: already registered in ${path}.\n`,
  });
}

function unregisterOpenCode(deps: CliDeps): Promise<ClientOutcome> {
  return editOpenCode(deps, removeOpenCodeServer, {
    changed: (path, location) => `OpenCode: removed ${location} from ${path}`,
    unchanged: (path) => `OpenCode: no "${SERVER_NAME}" entry in ${path}.\n`,
  });
}

const CLIENT_LABELS: Record<Client, string> = { claude: "Claude Code", opencode: "OpenCode" };

/** Registers with each client; returns 1 if any client failed. */
async function registerClients(deps: CliDeps, clients: readonly Client[]): Promise<number> {
  const changed: string[] = [];
  let failed = false;
  for (const client of clients) {
    const outcome = client === "claude" ? await registerClaude(deps) : await registerOpenCode(deps);
    if (outcome === "changed") changed.push(CLIENT_LABELS[client]);
    if (outcome === "failed") failed = true;
  }
  if (changed.length > 0) {
    deps.stdout(`Restart ${changed.join(" and ")} to load the "${SERVER_NAME}" MCP server.\n`);
  }
  return failed ? 1 : 0;
}

async function commandRegister(args: readonly string[], deps: CliDeps): Promise<number> {
  let clients: readonly Client[] = CLIENTS;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const value = arg === "--client" ? args[++index] : arg.startsWith("--client=") ? arg.slice(9) : undefined;
    if (value === undefined) {
      throw new CliError(`Usage: transversals register [--client ${CLIENTS.join("|")}]`, 2);
    }
    if (!(CLIENTS as readonly string[]).includes(value)) {
      throw new CliError(`Unknown client "${value}". Use one of: ${CLIENTS.join(", ")}.`, 2);
    }
    clients = [value as Client];
  }
  return registerClients(deps, clients);
}

// ---------------------------------------------------------------------------
// uninstall

async function removeGuestInstall(deps: CliDeps, vmId: string): Promise<void> {
  let output: string;
  try {
    output = await prlctl(
      deps,
      { operation: "exec", vmId, command: powershell(GUEST_REMOVE_SCRIPT) },
      COPY_TIMEOUT_MS,
    );
  } catch (error) {
    const cause = error instanceof OperatorError ? error.cause : undefined;
    const causeStdout =
      typeof cause === "object" && cause !== null ? (cause as { stdout?: unknown }).stdout : undefined;
    output = typeof causeStdout === "string" ? causeStdout : "";
    if (!output.includes("TRANSVERSALS_ERROR")) {
      deps.stderr(
        `Warning: could not run the guest cleanup (${describeError(error)}); %LOCALAPPDATA%\\transversals is still in the VM.\n`,
      );
      return;
    }
  }
  const marker = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("TRANSVERSALS_ERROR"));
  if (marker) {
    deps.stderr(
      `Warning: could not remove %LOCALAPPDATA%\\transversals in the guest (${marker.slice("TRANSVERSALS_ERROR remove-failed".length).trim() || "unknown error"}). Close MCP sessions using transversals and delete it manually.\n`,
    );
    return;
  }
  deps.stdout("Removed %LOCALAPPDATA%\\transversals from the guest.\n");
}

async function offerSnapshotDeletion(deps: CliDeps, vmId: string): Promise<void> {
  let ids: string[];
  try {
    ids = await ownedSnapshotIds(deps, vmId);
  } catch (error) {
    deps.stderr(`Warning: could not list snapshots (${describeError(error)}); none deleted.\n`);
    return;
  }
  if (ids.length === 0) {
    deps.stdout(`No "${OWNED_SNAPSHOT_NAME}" snapshot to delete.\n`);
    return;
  }

  const question =
    ids.length === 1
      ? `Delete the ${OWNED_SNAPSHOT_NAME} snapshot? [y/N] `
      : `Delete all ${ids.length} ${OWNED_SNAPSHOT_NAME} snapshots? [y/N] `;
  const answer = (await deps.prompt(question)).trim();
  if (!/^y(es)?$/i.test(answer)) {
    deps.stdout(`Kept snapshot "${OWNED_SNAPSHOT_NAME}".\n`);
    return;
  }
  for (const snapshotId of ids) {
    try {
      await prlctl(deps, { operation: "snapshot-delete", vmId, snapshotId }, SNAPSHOT_TIMEOUT_MS);
      deps.stdout(`Deleted snapshot "${OWNED_SNAPSHOT_NAME}" (${snapshotId}).\n`);
    } catch (error) {
      deps.stderr(`Warning: could not delete snapshot ${snapshotId}: ${describeError(error)}\n`);
    }
  }
}

async function commandUninstall(args: readonly string[], deps: CliDeps): Promise<number> {
  if (args.length > 0) throw new CliError(`uninstall takes no arguments.\n\n${USAGE}`, 2);
  let failed = false;

  await unregisterClaude(deps);
  if ((await unregisterOpenCode(deps)) === "failed") failed = true;

  let vmId: string | undefined;
  try {
    const configured = (await effectiveConfig(deps)).vmId;
    vmId = configured === undefined ? undefined : normalizeConfiguredUuid(configured, "vmId");
  } catch (error) {
    deps.stderr(`Warning: could not read the configured VM (${describeError(error)}).\n`);
  }

  if (vmId === undefined) {
    deps.stdout("No VM configured; skipped guest cleanup and snapshot.\n");
  } else {
    let vms: VmEntry[] | undefined;
    try {
      vms = await listVms(deps);
    } catch (error) {
      deps.stderr(`Warning: ${describeError(error)}; skipped guest cleanup and snapshot.\n`);
    }
    const vm = vms?.find((entry) => entry.uuid === vmId);
    if (vm) {
      if (vm.status === "running") {
        await removeGuestInstall(deps, vm.uuid);
      } else {
        deps.stdout(
          `VM "${vm.name}" is ${vm.status}; skipped guest cleanup (delete %LOCALAPPDATA%\\transversals in the guest yourself).\n`,
        );
      }
      await offerSnapshotDeletion(deps, vm.uuid);
    } else if (vms !== undefined) {
      deps.stdout(`Configured VM ${vmId} not found; skipped guest cleanup and snapshot.\n`);
    }
  }

  const { dir } = configPath(deps);
  try {
    await deps.removePath(dir);
    deps.stdout(`Removed ${dir}\n`);
  } catch (error) {
    failed = true;
    deps.stderr(`Could not remove ${dir}: ${describeError(error)}\n`);
  }

  deps.stdout(
    `\nTo remove the transversals package itself, run:\n${PACKAGE_REMOVAL_COMMANDS.map((command) => `  ${command}`).join("\n")}\n`,
  );
  return failed ? 1 : 0;
}

type CheckResult = { ok: true; detail: string } | { ok: false; detail: string } | { skip: string };

async function commandDoctor(args: readonly string[], deps: CliDeps): Promise<number> {
  if (args.length > 0) throw new CliError(`doctor takes no arguments.\n\n${USAGE}`, 2);
  let failures = 0;
  const report = (label: string, result: CheckResult): void => {
    const name = label.padEnd(18);
    if ("skip" in result) {
      deps.stdout(`SKIP  ${name}${result.skip}\n`);
    } else if (result.ok) {
      deps.stdout(`PASS  ${name}${result.detail}\n`);
    } else {
      failures++;
      deps.stdout(`FAIL  ${name}${result.detail}\n`);
    }
  };
  const check = async (label: string, action: () => Promise<string>): Promise<boolean> => {
    try {
      report(label, { ok: true, detail: await action() });
      return true;
    } catch (error) {
      report(label, {
        ok: false,
        detail: error instanceof CliError ? error.message : describeError(error),
      });
      return false;
    }
  };

  let config: CliConfig | undefined;
  await check("config", async () => {
    config = await requireConfig(deps);
    return `vm ${config.vmId}`;
  });

  let vm: VmEntry | undefined;
  if (config) {
    const { vmId } = config;
    await check("Parallels VM", async () => {
      vm = (await listVms(deps)).find((entry) => entry.uuid === vmId);
      if (!vm) throw new CliError(`No VM with uuid ${vmId}. Run \`transversals setup\`.`);
      return `"${vm.name}"`;
    });
  } else {
    report("Parallels VM", { skip: "needs config" });
  }

  let running = false;
  if (vm) {
    const found = vm;
    running = await check("VM running", async () => {
      if (found.status !== "running") {
        throw new CliError(`VM is ${found.status}. Start it with \`prlctl start ${found.uuid}\`.`);
      }
      return "running";
    });
  } else {
    report("VM running", { skip: "needs the VM" });
  }

  let toolsOk = false;
  if (config && running) {
    const { vmId } = config;
    toolsOk = await check("Parallels Tools", async () => {
      try {
        await prlctl(deps, { operation: "exec", vmId, command: ["cmd.exe", "/c", "ver"] });
      } catch (error) {
        throw new CliError(
          `\`prlctl exec\` did not work (${describeError(error)}). Install/update Parallels Tools and log in to Windows.`,
        );
      }
      return "prlctl exec works";
    });
  } else {
    report("Parallels Tools", { skip: "needs a running VM" });
  }

  if (config && toolsOk) {
    const { vmId, agentExecutable } = config;
    await check("guest agent", async () => {
      let hello: AgentHello;
      try {
        hello = await helloAgent(deps, vmId, agentExecutable);
      } catch (error) {
        throw new CliError(
          `No hello from ${agentExecutable} (${describeError(error)}). Rerun \`transversals setup\`.`,
        );
      }
      // Host and guest ship together, so anything but an exact match (incl. "unknown") is stale.
      const agentVersion = hello.version;
      const hostVersion = await packageVersion(deps);
      if (agentVersion !== hostVersion) {
        throw new CliError(
          `Guest agent is ${agentVersion} but this host is ${hostVersion} at ${agentExecutable}. Rerun \`transversals setup\`.`,
        );
      }
      // Older agents don't report native files; skip the check rather than fail them.
      if (hello.reportsNativeFiles) {
        const missing = hello.missingNativeFiles;
        if (!Array.isArray(missing) || !missing.every((name) => typeof name === "string")) {
          throw new CliError(
            `Guest agent at ${agentExecutable} sent an unreadable missingNativeFiles list. Rerun \`transversals setup\`.`,
          );
        }
        if (missing.length > 0) {
          throw new CliError(
            `Guest agent at ${agentExecutable} is missing native files: ${missing.join(", ")}. Rerun \`transversals setup\`.`,
          );
        }
      }
      return `version ${agentVersion} at ${agentExecutable}`;
    });
  } else {
    report("guest agent", { skip: "needs Parallels Tools" });
  }

  if (config && vm) {
    const { vmId } = config;
    await check("baseline snapshot", async () => {
      const ids = await ownedSnapshotIds(deps, vmId);
      if (ids.length === 0) {
        throw new CliError(`No "${OWNED_SNAPSHOT_NAME}" snapshot. Run \`transversals setup\` to create it.`);
      }
      if (ids.length > 1) {
        throw new CliError(
          `${ids.length} "${OWNED_SNAPSHOT_NAME}" snapshots; delete the extras so exactly one remains.`,
        );
      }
      return `"${OWNED_SNAPSHOT_NAME}" (${ids[0]})`;
    });
  } else {
    report("baseline snapshot", { skip: "needs the VM" });
  }

  if (failures > 0) {
    deps.stderr(`${failures} check(s) did not pass (marked FAIL above).\n`);
    return 1;
  }
  deps.stdout("All checks passed.\n");
  return 0;
}

type StreamArgs = { fps: number; maxSize: number; quality: number; vm?: string };

const STREAM_INT_FLAGS = {
  "--fps": { key: "fps", min: 1, max: 30, fallback: 15 },
  "--max-size": { key: "maxSize", min: 320, max: 1_920, fallback: 800 },
  "--quality": { key: "quality", min: 30, max: 95, fallback: 70 },
} as const;
type StreamIntFlag = keyof typeof STREAM_INT_FLAGS;

function parseStreamArgs(args: readonly string[]): StreamArgs {
  const seen = new Set<string>();
  const parsed: StreamArgs = {
    fps: STREAM_INT_FLAGS["--fps"].fallback,
    maxSize: STREAM_INT_FLAGS["--max-size"].fallback,
    quality: STREAM_INT_FLAGS["--quality"].fallback,
  };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag !== "--vm" && !Object.hasOwn(STREAM_INT_FLAGS, flag)) {
      throw new CliError(
        `${flag.startsWith("-") ? "Unknown stream option" : "Unexpected stream argument"} "${flag}".\n\n${USAGE}`,
        2,
      );
    }
    if (seen.has(flag)) throw new CliError(`${flag} was given more than once.`, 2);
    seen.add(flag);
    const value = args[++index];

    if (flag === "--vm") {
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new CliError("--vm needs a VM name or uuid.", 2);
      }
      parsed.vm = value;
      continue;
    }
    const spec = STREAM_INT_FLAGS[flag as StreamIntFlag];
    // Digits only: rejects signs, decimals, blanks, and a following flag taken as the value.
    const number = value !== undefined && /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!(number >= spec.min && number <= spec.max)) {
      throw new CliError(
        `${flag} needs an integer from ${spec.min} to ${spec.max}${value === undefined ? "" : `, got "${value}"`}.`,
        2,
      );
    }
    parsed[spec.key] = number;
  }
  return parsed;
}

async function commandStream(args: readonly string[], deps: CliDeps): Promise<number> {
  const options = parseStreamArgs(args);
  // stdout carries binary frames from here on: every message goes to stderr.
  const config = await requireConfig(deps);
  const vms = await listVms(deps);
  let vm: VmEntry;
  if (options.vm === undefined) {
    const configured = vms.find((entry) => entry.uuid === config.vmId);
    if (configured === undefined) {
      throw new CliError(
        `The configured VM ${config.vmId} was not found. Run \`transversals setup\`, or pass --vm <name|uuid>.`,
      );
    }
    vm = configured;
  } else {
    vm = resolveVm(vms, options.vm);
  }
  if (vm.status !== "running") {
    throw new CliError(
      `VM "${vm.name}" is ${vm.status}. Start it (prlctl start ${vm.uuid}) and log in to Windows first.`,
    );
  }

  return relayStream({
    spawnProcess: deps.spawnProcess,
    args: [
      "exec",
      vm.uuid,
      "--current-user",
      config.agentExecutable,
      "stream",
      "--fps",
      String(options.fps),
      "--max-long-edge",
      String(options.maxSize),
      "--quality",
      String(options.quality),
    ],
    sink: deps.streamOut,
    onSignal: deps.onSignal,
    stderr: deps.stderr,
  });
}

async function packageVersion(deps: CliDeps): Promise<string> {
  const raw = await deps.readFile(join(deps.packageRoot, "package.json"));
  const version = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== "string") throw new CliError("package.json has no version.");
  return version;
}

/** Runs one `transversals` invocation and resolves to its process exit code. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "-h":
      case "--help":
      case "help":
        deps.stdout(USAGE);
        return 0;
      case "-V":
      case "--version":
        deps.stdout(`${await packageVersion(deps)}\n`);
        return 0;
      case "serve":
        return await commandServe(args, deps);
      case "setup":
        return await commandSetup(args, deps);
      case "doctor":
        return await commandDoctor(args, deps);
      case "config":
        return await commandConfig(args, deps);
      case "register":
        return await commandRegister(args, deps);
      case "uninstall":
        return await commandUninstall(args, deps);
      case "stream":
        return await commandStream(args, deps);
      default:
        deps.stderr(
          `${command === undefined ? "" : `Unknown command "${command}".\n\n`}${USAGE}`,
        );
        return 2;
    }
  } catch (error) {
    if (error instanceof CliError) {
      deps.stderr(`${error.message}\n`);
      return error.exitCode;
    }
    deps.stderr(`transversals: ${describeError(error)}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Process entry (dist/cli.js, the `transversals` bin)

const INSTALLED_PACKAGE_ROOT = "/usr/local/lib/transversals";
const INSTALLED_BIN = "/usr/local/bin/transversals";

/**
 * Fallback locations for `claude` when it is not on PATH (GUI- or pkg-launched
 * processes often get a minimal PATH).
 */
function claudeFallbacks(home: string): string[] {
  return [join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
}

function processRunCommand(home: string): RunCommand {
  return async (executable, args, options) => {
    try {
      return await defaultRunCommand(executable, args, options);
    } catch (error) {
      if (executable !== "claude" || errorCode(error) !== "ENOENT") throw error;
      for (const candidate of claudeFallbacks(home)) {
        try {
          return await defaultRunCommand(candidate, args, options);
        } catch (fallbackError) {
          if (errorCode(fallbackError) !== "ENOENT") throw fallbackError;
        }
      }
      throw error;
    }
  };
}

async function terminalPrompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export function createProcessDeps(): CliDeps {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const home = homedir();
  return {
    runCommand: processRunCommand(home),
    spawnProcess: spawn as SpawnImplementation,
    env: process.env,
    homedir: home,
    packageRoot,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, content) => writeFile(path, content, "utf8"),
    mkdir: (path, options) => mkdir(path, options),
    startServer: (config) =>
      startStdioServer({
        ...process.env,
        TRANSVERSALS_VM_ID: config.vmId,
        TRANSVERSALS_UI_AGENT_EXECUTABLE: config.agentExecutable,
      }),
    // Installed builds register the stable bin; dev checkouts register node + this checkout.
    serveCommand:
      packageRoot === INSTALLED_PACKAGE_ROOT
        ? [INSTALLED_BIN, "serve"]
        : [process.execPath, join(packageRoot, "dist", "cli.js"), "serve"],
    prompt: terminalPrompt,
    removePath: (path) => rm(path, { recursive: true, force: true }),
    streamOut: process.stdout,
    onSignal: (handler) => {
      const listener = (signal: NodeJS.Signals) => handler(signal as "SIGINT" | "SIGTERM");
      process.on("SIGINT", listener);
      process.on("SIGTERM", listener);
      return () => {
        process.off("SIGINT", listener);
        process.off("SIGTERM", listener);
      };
    },
  };
}

function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolvePromise) => stream.write("", () => resolvePromise()));
}

const FINAL_FLUSH_TIMEOUT_MS = 2_000;

/** Flushes stdout/stderr, but gives up after 2 s so a paused consumer cannot keep the process alive. */
async function flushOutputs(): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  // Not unref'd: it must keep the loop alive until process.exit(code), or Node could exit 0 first.
  // It is always cleared below, so it never delays a flush that completes.
  const timeout = new Promise<void>((resolvePromise) => {
    timer = setTimeout(resolvePromise, FINAL_FLUSH_TIMEOUT_MS);
  });
  try {
    await Promise.race([Promise.all([flush(process.stdout), flush(process.stderr)]), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "stream") {
    // A closed consumer (EPIPE) is reported to the stream relay as an "error" event. Keep a
    // listener for the whole process so a late EPIPE (e.g. during the final flush) never crashes.
    process.stdout.on("error", () => undefined);
  }
  const code = await runCli(argv, createProcessDeps());
  // A started server owns the process lifetime (it exits when stdin closes).
  if (code === 0 && argv[0] === "serve") return;
  await flushOutputs();
  process.exit(code);
}

function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    // npm installs the bin as a symlink, so compare real paths.
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main();
}

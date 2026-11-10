# Transversals

Transversals is a general-purpose MCP server that lets [OpenCode](https://opencode.ai) and Claude Code drive **your own Parallels Windows 11 ARM VM** (a "transversal" across Parallels). It runs PowerShell, takes screenshots, sends keyboard/mouse input, manages windows, and reads and operates the Windows UI through UI Automation.

Transversals is open source (MIT) and works only on Apple Silicon Macs with Parallels Windows 11 ARM VMs. The installer is an unsigned `.pkg` that you build with `npm run pkg` (see [Development](#development)).

## Requirements

- Apple Silicon Mac
- Parallels Desktop with `prlctl` (an edition that supports `prlctl`)
- A **running** Windows 11 ARM VM with Parallels Tools and a user logged in to the Windows console
- Mac folder sharing available to the VM. `setup` adds a temporary read-only share (`transversals-provision`) to copy the agent in, then removes it. If the guest can't see it, run `prlctl set <vm> --shf-host on`.
- Claude Code and/or OpenCode

The guest agent is self-contained (an exe plus four native DLLs), so the VM needs no .NET runtime. Node is bundled in the package.

## Install

1. Install the package:

   ```sh
   sudo installer -pkg transversals-<version>.pkg -target /
   ```

   The package is unsigned, so Gatekeeper blocks a downloaded copy on double-click. Install it with the command above, or remove the quarantine flag first (`xattr -d com.apple.quarantine transversals-<version>.pkg`) and then double-click it. A package you built yourself isn't quarantined.

2. Run setup with the VM running and logged in:

   ```sh
   transversals setup [--vm "<name or uuid>"]
   ```

   `--vm` is optional only when you have exactly one VM. Setup:
   - temporarily shares the agent with the VM and copies it (the exe, then the rest of the agent folder: four native DLLs) to `%LOCALAPPDATA%\transversals\agent` in the guest, then removes the share
   - verifies the agent responds, and warns if its version differs from the host's (the bundled agent is stale)
   - saves the VM and agent path to the config file
   - creates the `transversals-baseline` snapshot if it doesn't exist
   - registers `transversals` with Claude Code and OpenCode (skipped for a client that isn't installed; `--no-register` skips both, `transversals register [--client claude|opencode]` does it later)

3. Restart Claude Code / OpenCode.

Check everything with `transversals doctor`. It reports PASS/FAIL/SKIP for config, VM, VM running, Parallels Tools, guest agent, and baseline snapshot. The guest agent check compares the agent's version with the host's and **fails on any mismatch** (including an agent that reports "unknown"); the fix is to rerun `transversals setup`.

## Tools

All tools take the configured `vmId`.

| Tool | Purpose |
| --- | --- |
| `vm_status` | Get the VM's Parallels status. |
| `vm_start` | Start the VM. |
| `run_powershell` | Run bounded PowerShell (max 8,192 characters) in the guest's interactive session. Results include `stdoutTruncated` / `stderrTruncated` flags when output was cut. |
| `take_screenshot` | Capture the guest screen. Returns the image with `{imageWidth, imageHeight, screen}`. |
| `send_input` | Type text, press a key chord (e.g. `ctrl+shift+s`), or click at coordinates. |
| `list_windows` | List top-level windows with handles, titles, and owning processes. |
| `focus_window` | Bring a window to the foreground by handle from `list_windows`. |
| `ui_snapshot` | Capture a bounded UI Automation tree. |
| `ui_find` | Find one element with a semantic locator. |
| `ui_interact` | Run an ordered, fail-fast batch of 1–50 semantic commands (find, interact, assert, wait). |
| `vm_restore` | Restore the VM to `transversals-baseline`. **Destructive**: requires `confirm: true` and discards all guest changes since the baseline. |

**Click coordinates.** `send_input` click `x`/`y` are virtual-screen pixels, not screenshot pixels. For a point `(px, py)` in a screenshot:

```
x = screen.left + px * screen.width  / imageWidth
y = screen.top  + py * screen.height / imageHeight   (rounded to integers)
```

**Restore safety.** `vm_restore` only ever restores the snapshot named `transversals-baseline` that `setup` created. It fails if there isn't exactly one.

**Truncation.** `run_powershell` output is capped, with the `stdoutTruncated` / `stderrTruncated` flags above. `ui_snapshot` is bounded by depth, node count, and response size; a truncated snapshot includes truncation metadata (e.g. `reasons`, `includedNodes`, `omittedNodesAtLeast`, `truncatedFields`).

**Semantic locators** match on `role`, `name`, `text`, `value`, and `ancestor`/`descendant`/`sibling` context, with optional `fuzzy` and zero-based `index`. No match returns `NOT_FOUND`. An ambiguous match returns `AMBIGUOUS_MATCH` with a few candidates instead of guessing. References are valid only for the current snapshot; `ref: "$last"` reuses the latest reference within a batch.

## Live stream

`transversals stream` is a CLI command (not an MCP tool) that streams the guest screen as MJPEG (concatenated JPEG frames) to stdout. It uses its own `prlctl exec` connection, so it doesn't block MCP tool calls.

```sh
transversals stream [--fps 1-30] [--max-size 320-1920] [--quality 30-95] [--vm <name|uuid>]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--fps` | 15 | Frames per second |
| `--max-size` | 800 | Longest image edge in pixels |
| `--quality` | 70 | JPEG quality |
| `--vm` | configured VM | VM name or UUID |

```sh
transversals stream | mpv --demuxer-lavf-format=mjpeg --profile=low-latency --untimed -
transversals stream | ffplay -f mjpeg -
```

- Needs a running VM with a logged-in user and the guest agent from this version (see Upgrading).
- Exits 0 on Ctrl-C/SIGTERM or when the consumer closes the pipe. Exits 1 if the first frame doesn't arrive within 10 s, if frames stall for more than 5 s, or if the relay dies.
- A slow consumer gets frames dropped, never partial JPEGs.
- Diagnostics go to stderr only; stdout is binary video.
- The guest side stops by itself when the host goes away (stdin closed, a failed write, or a write stalled for 5 s). The host also sends a heartbeat on the agent's stdin every second, and the guest exits after 5 s without one, which covers the host or `prlctl` being killed abruptly.
- On shutdown, the final flush of buffered output is bounded to 2 s.
- Pacing: a capture and encode takes ~27 ms, and in the VM a short wait wakes 15–20 ms late. The stream captures a slot that is late by less than one frame period instead of skipping it. Slots missed by a whole period are still dropped, never sent as a burst, and it never runs faster than `--fps`.
- Observed performance (not a guarantee; test VM with 4 vCPU, 2560×1402, version 0.2.2): `--fps 30` gave ≈29.6 fps at ~42% of one guest core, and `--fps 15` gave 15.0 fps at ~24% (~135 MB at 15 fps in an earlier measurement). The ceiling is ≈37 fps (the capture time); `--fps` still maxes out at 30.

## Guest agent lifecycle

The MCP server starts one agent per session over `prlctl exec` (NDJSON). The host says hello to each new agent, and for protocol 2 and later sends a blank keepalive line every 5 s; older agents get no keepalives. The agent exits after 30 s with no input, so it idles out 30 s after its host disappears.

## Configuration

Config file: `~/Library/Application Support/transversals/config.json`, with keys `vmId` and `agentExecutable`.

| Environment variable | Overrides |
| --- | --- |
| `TRANSVERSALS_VM_ID` | `vmId` |
| `TRANSVERSALS_UI_AGENT_EXECUTABLE` | `agentExecutable` |

```sh
transversals config                       # show effective config (env overrides the file)
transversals config set vmId <uuid>
transversals config set agentExecutable '<guest path to Transversals.GuestAgent.exe>'
```

## Upgrading

1. Install the new `.pkg`.
2. Make sure no old agent is running. Setup reports "in use" otherwise. Close MCP sessions; note that the OpenCode service keeps an MCP `serve` alive, so you may also need to stop the agent in the guest: `Get-Process Transversals.GuestAgent | Stop-Process`.
3. Rerun `transversals setup`.
4. Refresh the baseline snapshot: the existing `transversals-baseline` is left unchanged and still holds the **old agent**, so `vm_restore` would bring it back. Delete the snapshot (Parallels Snapshot Manager, or `prlctl snapshot-delete <vm> --id <snapshot-id>`) and rerun `setup`. Setup warns about this, and `transversals doctor` flags a stale agent.

`transversals stream` needs the guest agent from the same version. Against an older agent, a stream trips the 10 s first-frame watchdog and prints a hint.

## Uninstall

```sh
transversals uninstall
```

This unregisters from Claude Code and OpenCode, removes `%LOCALAPPDATA%\transversals` from the VM (if running), offers to delete the baseline snapshot (default: no), and removes the config directory. It then prints the `sudo` commands that remove the package itself; run them yourself.

## Troubleshooting

- **`AGENT_UNAVAILABLE`**: run `transversals doctor`. Usual causes: VM stopped, nobody logged in to Windows, Parallels Tools not running, or a missing/outdated agent (rerun `setup`).
- **"installed guest agent is in use" during setup**: close MCP sessions using Transversals (or end `Transversals.GuestAgent.exe` in the guest with `Get-Process Transversals.GuestAgent | Stop-Process`), then rerun `setup`.
- **Guest can't see the share during setup**: make sure Mac folder sharing is on (`prlctl set <vm> --shf-host on`). To clear a stale share: `prlctl set <vm> --shf-host-del transversals-provision`.
- **"No video frame from the guest agent for 10 s" / "5 s" (`transversals stream`)**: the guest isn't producing frames. Check that Windows is logged in and run `transversals doctor`; if the agent is outdated, rerun `transversals setup`.
- **Agent before 0.2.0 crashes immediately (exit 255; the Windows event log shows `wpfgfx_cor3.dll` with `0xc000001d`) after the VM was stopped abruptly**: its single-file extraction cache may be corrupt. Upgrade to 0.2.0+, which ships the native DLLs beside the exe and no longer extracts to `%TEMP%\.net`. For an old agent, delete `%TEMP%\.net\Transversals.GuestAgent\` in the guest (no agent running) and retry; leftover folders from old agents can be deleted.
- **`SNAPSHOT_NOT_FOUND`**: run `transversals setup` to create `transversals-baseline`.
- **`SNAPSHOT_AMBIGUOUS`**: more than one `transversals-baseline` snapshot exists. Delete the extras in Parallels Snapshot Manager so exactly one remains.

## Development

Requires Node 22 and the .NET 8 SDK.

```sh
npm install
npm run build          # compile the host (tsc)
npm test               # host tests (vitest)
npm run verify         # tests, typecheck, build, guest tests and build
npm run guest:publish  # publish the self-contained win-arm64 agent to dist/guest/win-arm64
npm run pkg            # build out/transversals-<version>.pkg (unsigned, bundles Node 22 arm64)
```

`npm run pkg` needs the arm64 Node 22 build and a warm npm cache (production dependencies are installed offline).

Layout:

- `src/`: host MCP server (`index.ts`), CLI (`cli.ts`), stream relay (`stream.ts`), OpenCode config editing, guest-agent client
- `guest/`: .NET guest agent (`src/`) and its tests (`tests/`). With no arguments the agent runs the NDJSON session; `Transversals.GuestAgent.exe stream [--fps] [--max-long-edge] [--quality]` runs the frame stream used by `transversals stream`.
- `tests/`: host tests, including a fake guest agent
- `scripts/`: `build-pkg.sh`
- `docs/plans/`: design plans

## License

MIT, see [LICENSE](LICENSE).

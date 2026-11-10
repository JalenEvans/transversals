# Browser DOM automation plan

## Objective and evidence

Add narrowly scoped browser DOM automation to the Transversals MCP server for pages whose
controls are not represented usefully by desktop UI Automation (UIA). The
motivating check exposed Windows UIA as a table/flattened text for Web Sudoku,
not as individual editable cells. The accessible local Sudoku page was solved
through the existing Windows UIA semantic tools because its HTML produced
individually named accessible Edit controls. That contrast demonstrates
markup/accessibility-tree dependence: direct DOM automation would handle legacy
pages whose controls UIA does not expose, rather than expanding UIA semantics.

This is a proposed plan, not an approval or an implementation claim.

## Recommendation

Run a guest-side Playwright browser agent over the existing
`prlctl exec --current-user` stdio/NDJSON transport. Launch the installed Edge
channel with a dedicated automation profile. Keep the transport local: do not
add a network listener, firewall rule, or application authentication layer.

DOM automation must remain explicitly separate from desktop UIA:

- UIA tools continue to inspect and act on the Windows accessibility tree.
- Browser tools inspect and act on the page DOM through Playwright.
- There is no silent DOM/UIA, coordinate, or OCR fallback. A tool reports its
  own bounded failure and the caller chooses another tool explicitly.

## Proposed MCP surface

Expose five tools, with schemas and limits aligned to the existing semantic
tools:

- `browser_open` — start or reuse this invocation's owned Edge instance and
  open a URL in a new or selected tab.
- `dom_snapshot` — return a bounded, structured view of the selected page,
  including tabs/frames as applicable.
- `dom_find` — resolve one element using semantic DOM locators and return an
  opaque reference.
- `dom_interact` — execute an ordered, fail-fast batch of bounded DOM commands
  such as fill, click, press, select, check, and wait/assert.
- `browser_close` — close only the browser instance owned by this invocation
  and release its profile/session resources.

Required behavior:

- Bound snapshot depth, node count, text, candidate count, and response UTF-8
  size; return truncation metadata.
- Use opaque refs scoped to the current page/frame and snapshot or operation
  context. Do not expose selectors as a promise of stable identity.
- Treat zero matches as `NOT_FOUND` and multiple matches as
  `AMBIGUOUS_MATCH`; never guess. Return a bounded candidate summary.
- Make batches ordered and fail-fast, reporting the failed command index.
- Define cleanup ownership: the creating MCP session owns the browser, context,
  pages, and temporary profile; cleanup runs on explicit close and transport
  shutdown where possible.
- Model tabs/pages and frames explicitly. A locator must not cross a frame
  boundary implicitly; the selected tab/frame is part of the operation target.

## MVP scope

- Launch installed Edge with an isolated, disposable automation profile.
- Open local or user-supplied pages through Playwright and expose page/tab
  selection.
- Snapshot accessible DOM roles, names, text, common attributes, editable
  state, and frame boundaries within strict limits.
- Resolve semantic locators and execute safe form/control interactions with
  assertions and bounded waits.
- Support the original Web Sudoku flow through DOM controls as live acceptance.
- Preserve stdio/NDJSON and the current-user guest-session model.

### Non-goals

- Replacing or extending desktop UIA (`ui_snapshot`, `ui_find`, `ui_interact`),
  `take_screenshot`, coordinate input via `send_input`, or OCR.
- Attaching to or closing arbitrary existing Edge/browser sessions.
- A general web crawler, remote browser service, network listener, or browser
  fleet manager.
- Stealth automation, CAPTCHA bypass, arbitrary JavaScript execution, or
  unrestricted downloads/uploads in the MVP.
- Sharing cookies, saved credentials, or the user's normal Edge profile.

## Architecture and data flow

```text
MCP client
  -> host MCP server (stdio)
  -> prlctl exec --current-user
  -> guest browser agent (stdio/NDJSON)
  -> Playwright
  -> installed Edge + dedicated automation profile
  -> page / tabs / frames / DOM

browser_open: host request -> guest agent -> owned browser/context/page
dom_snapshot/find/interact: host request -> scoped page/frame -> bounded result
browser_close or session shutdown: owner -> context/browser close -> profile cleanup
```

The host owns the guest process lifetime and request correlation. The guest
agent owns Playwright objects and enforces browser-specific bounds. Neither
side should infer UIA elements from DOM results or vice versa.

## Security and lifecycle constraints

- Run as the logged-in interactive Windows user via the existing
  `--current-user` path; do not require UAC, secure-desktop access, a service,
  or unattended login.
- Use a user-owned, uniquely named automation profile under the user's local
  application data, with explicit isolation from the normal Edge profile.
- Do not read or mutate the normal profile, attach to its processes, adopt its
  pages, or close arbitrary browser sessions.
- Generate and validate opaque session/page/frame refs inside the agent;
  reject stale, foreign, or cross-session refs.
- Bound navigation, waits, DOM extraction, command batches, and output size.
- Close owned pages/context/browser on normal shutdown and best-effort on
  failure; remove temporary profile data unless persistence is explicitly
  selected and approved.
- Keep network exposure unchanged. Document any navigation policy and decide
  whether MVP permits only local/file URLs or also ordinary HTTPS navigation.

## Delivery phases and estimates

### Phase 1 — MVP (2–4 days)

- Confirm guest runtime packaging and installed Edge discovery.
- Implement the guest Playwright agent and NDJSON request/response contract.
- Add the five MCP tools with schemas, bounds, refs, ambiguity errors, tab/frame
  selection, ordered batches, and owned cleanup.
- Add focused host/agent tests and a live Web Sudoku DOM-control acceptance
  script/runbook.
- Update maintained user-facing setup/tool documentation only after the
  behavior is implemented and its documentation impact is confirmed.

### Phase 2 — production hardening (1–2 weeks)

- Exercise crash, timeout, stale-ref, concurrent-request, restore, and process
  cleanup paths.
- Harden profile isolation, navigation policy, redaction, limits, and
  cancellation.
- Cover frames and shadow DOM where the chosen locator contract supports them;
  define explicit behavior for downloads, dialogs, uploads, and auth state.
- Pin and verify the Edge/Playwright compatibility matrix, improve diagnostics,
  and complete live acceptance across cold boot, warm session, and snapshot
  restore scenarios.

## Testing and live acceptance

High-value automated coverage should include protocol framing, malformed and
oversized requests, bounds/truncation, exact-one matching, ambiguity and
not-found errors, stale/foreign refs, frame targeting, ordered fail-fast
batches, wait/assert timeouts, tab lifecycle, browser cleanup, and process
failure. Include a local deterministic page with inputs, buttons, tables,
iframes, and dynamic state.

Live acceptance should verify that the guest is manually logged in, Edge is
launched with the dedicated profile, a local page can be opened and inspected,
and the original Web Sudoku is solved through DOM controls—not coordinates,
OCR, screenshots, or UIA. Confirm the browser closes cleanly and that the
normal Edge profile and the `transversals-baseline` snapshot remain unaffected.

## Risks and open decisions

- **Guest runtime:** choose Node.js/Playwright in the guest or .NET
  Playwright. Node may align with the host ecosystem; .NET may better fit the
  existing guest agent (`Transversals.GuestAgent`, a self-contained win-arm64
  .NET executable). Verify ARM64/Windows packaging before committing.
- **Edge channel/versioning:** locate the installed Edge channel, define
  Playwright browser compatibility, and decide whether launch uses the system
  executable or a managed browser binary.
- **Auth/profile persistence:** decide whether MVP is always fresh and
  disposable or permits an explicitly persisted, user-owned profile; never
  silently persist credentials or cookies.
- **DOM boundaries:** decide iframe and shadow DOM traversal semantics,
  including ref scope and snapshot representation.
- **Downloads/dialogs:** decide whether browser dialogs, downloads, uploads,
  permissions, and popups are MVP capabilities or explicit unsupported errors.
- **Snapshot restoration:** determine whether the guest agent/runtime and
  dedicated profile are captured in the `transversals-baseline` snapshot (the
  one `vm_restore` restores; it keeps whatever agent was installed when taken),
  and ensure cleanup does not create persistence assumptions that restore
  removes.

## Rollout, rollback, and definition of done

Roll out behind an explicit capability/tool registration change; existing UIA
tools must behave unchanged when browser support is unavailable. Roll back by
disabling the browser tool registration and removing the guest browser agent
and temporary profile artifacts; do not alter the VM baseline or normal Edge
profile as part of rollback.

The work is done when the five tools have reviewed schemas and bounded,
documented error behavior; the guest transport and owned lifecycle pass
automated tests; no silent fallback or network listener was introduced; the
Web Sudoku DOM acceptance succeeds; cold/warm/restore cleanup is verified; and
the repository's applicable verification commands pass. This plan itself does
not assert that any of those implementation outcomes has occurred.

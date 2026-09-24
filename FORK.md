# Fork notes

Personal fork of [`patty-io/pi-patty-bg-tasks`](https://github.com/patty-io/pi-patty-bg-tasks),
MIT licensed. All credit for the extension belongs upstream.

## Base

| | |
|---|---|
| Upstream repo | `github.com/patty-io/pi-patty-bg-tasks` |
| Base commit | `6676db5` — `fix(timeout): silent backgrounding — no forced job_decide turn — v1.1.6` |
| Base version | `1.1.6` (the latest published npm release) |
| Why not `main` | `main` is an unreleased `2.0.0` breaking re-architecture: 48 files, ±1900 lines. It does not change the 120s constant, so it buys nothing here and would drag in unvetted churn. |

Upstream publishes **no git tags**, so this fork's pin is the commit SHA above plus
its own local tag (see below).

## Change 1 — auto-background threshold (15s)

`src/types.ts` — the auto-background threshold:

```diff
-// --- Configuration constants ---
-export const DEFAULT_TIMEOUT_MS = 120_000;
+// --- Configuration constants ---
+// Override with PI_PATTY_BG_TIMEOUT_MS. Defaults to 15s to match Claude Code's
+// assistant blocking budget (ASSISTANT_BLOCKING_BUDGET_MS = 15_000).
+const ENV_TIMEOUT_MS = Number(process.env.PI_PATTY_BG_TIMEOUT_MS);
+export const DEFAULT_TIMEOUT_MS =
+  Number.isFinite(ENV_TIMEOUT_MS) && ENV_TIMEOUT_MS > 0 ? ENV_TIMEOUT_MS : 15_000;
```

### Why 15s

Claude Code runs **two separate clocks**, and upstream patty collapsed them into one:

| Clock | Value | Role |
|---|---|---|
| `ASSISTANT_BLOCKING_BUDGET_MS` | `15_000` | *"blocking commands are automatically backgrounded after 15 seconds"* — the actual auto-background trigger |
| `BASH_DEFAULT_TIMEOUT_MS` | `120_000` | The kill timeout when no explicit `timeout` is passed |
| `BASH_MAX_TIMEOUT_MS` | `600_000` | Ceiling on a requested timeout |

Upstream's own changelog reads: *"Default auto-background timeout is now 120s
**(was 15s)**, matching Claude Code."* Reverting to 15s restores patty's original
behavior and matches the clock that actually matters.

Non-functional changes: the `package.json` version and peer list, a README fork
notice, and this file.

## Change 2 — clickable strip widget (milestone 0)

The pill bar above the editor used `setWidget(key, string[])`. Pi's string form is
capped at `MAX_WIDGET_LINES = 10` (past that it renders `... (widget truncated)`)
and, being plain text, **cannot receive mouse events**. Pi's `setWidget` has a
second overload taking a component factory — no cap, and it supports
`handleMouse`.

| File | Change |
|---|---|
| `src/strip.ts` *(new)* | `StripComponent`, `createStripWidget()`, `openStripPanel()` |
| `src/types.ts` | `UiContext.setWidget` widened to the factory overload; adds `custom()`, `mode`, and the `Strip*` types |
| `src/state.ts` | `stripInstalled`, `stripTui`, `lastStatusText` |
| `src/registry.ts` | `renderSidebar` installs the component widget once; the ticker drives `requestRender()` |

Hit-testing follows Pi's own `SelectList`: `TuiMouseEvent.y` is component-local
and zero-based, so row N is simply `rows[event.y]`. Events that are not a left
press/click on an occupied row return `undefined` rather than `{ handled: true }`,
so Pi keeps its fallbacks — primary-button drags stay available for transcript
selection, and wheel events still scroll.

Two constraints worth remembering:

- **The update model inverts.** A string widget is replaced every tick; a
  component is created once by the factory and Pi keeps that instance. Live
  updates therefore go through `requestRender()`, and the component reads
  registry state at render time rather than receiving new strings.
- **Non-TUI contexts keep the string path.** The component path is gated on
  `ctx.mode === "tui"`, which is Pi's own guard for `ctx.ui.custom()`.
- Classes here use plain field declarations, not constructor parameter
  properties, so the module loads under a strip-only TS transform too.

Milestone 0 scope: clicking a row opens an intentionally empty panel, proving the
click path end-to-end. See Change 3 for the visual layer on top.

## Change 3 — status colours, attention policy, collapse

### Colour

Pi theme slots, so the strip follows the active theme rather than hard-coding:

| State | Glyph | Slot |
|---|---|---|
| running | `▶` | `accent` |
| running, stalled | `▶` | `warning` |
| completed | `✓` | `success` |
| failed | `✗` | `error` |
| killed | `⊘` | `muted` |

`killed` gets its own glyph and slot. Upstream `statusIcon()` maps both `failed`
and `killed` to `✗`, so a job you deliberately stopped was indistinguishable from
one that broke. And `warning` is reserved for the stall watcher's verdict rather
than a kill: pure yellow is the loudest slot Pi ships and should mean "something
is wrong", not "you pressed Ctrl+X".

Rows now contain ANSI, so `render()` uses `truncateToWidth` from
`@earendil-works/pi-tui` instead of code-point slicing — the previous approach was
only safe because rows were plain text. That adds the package's first non-core
import, declared in `peerDependencies`.

### Which jobs the strip shows

Upstream rendered running jobs only, which is why `error` and `success` had
nowhere to appear. The policy is now:

- running fills the visible budget first
- **failures ride below the running rows and are never displaced by the limit** —
  an unacknowledged failure is an outstanding decision, not stale history
- completed / killed are **expanded-only** and dimmed (you just stopped it, or it
  already succeeded)
- a toggle line appears only when something is actually hidden

### Collapse

`STRIP_VISIBLE_LIMIT` (default **3**, override with `PI_PATTY_STRIP_LIMIT`,
clamped to 20) bounds the collapsed view. Clicking `▾ +N more` expands; `▴ collapse`
returns. The component overload has **no `MAX_WIDGET_LINES` guard**, so this limit
is the only bound on strip height — do not remove it without another.

### Stall state

`monitoring.ts` already detected stalled jobs, but the verdict was one-shot: it
messaged the agent and cancelled, persisting nothing. It now also invokes an
`onStall` callback and `lifecycle.ts` sets `job.stalled = true`, giving the strip
a real state to render instead of a log-mtime heuristic that would false-positive
on any legitimately quiet build.

### Mouse click contract

Pi delivers **both** a `press` and a `click` for one physical click. Handling each
independently fired the action twice, and the second pass read the row list *after*
the first pass had mutated it — so clicking `▾ +N more` expanded **and** opened
whichever job had landed on that row index. `handleMouse` now mirrors Pi's
`SelectList`: `press` records the row index, `click` activates using it.

### Collapse count

The toggle counts what expansion *would* reveal, not merely what is hidden at that
instant. The `quiet` (completed/killed) rows are empty while collapsed, so
comparing against the rendered row count alone reported "nothing hidden" and left
those jobs with no affordance to reach them.

```sh
PI_PATTY_STRIP_LIMIT=5 pi    # show 5 rows before collapsing
```

## Environment override

```sh
PI_PATTY_BG_TIMEOUT_MS=10000 pi    # 10s
PI_PATTY_BG_TIMEOUT_MS=30000 pi    # 30s
```

Unset or non-positive values fall back to 15s.

## Install

```sh
pi install git:github.com/tomkhoailang/pi-patty-bg-tasks@v1.3.1-pi15
```

## Rebase onto a newer upstream release

```sh
git clone https://github.com/tomkhoailang/pi-patty-bg-tasks.git
cd pi-patty-bg-tasks
git remote add upstream https://github.com/patty-io/pi-patty-bg-tasks.git
git fetch upstream
git rebase <new-upstream-commit>

# Re-apply the constant change if the rebase conflicts, then:
node -e "const s=require('fs').readFileSync('src/types.ts','utf8'); \
  if(!/PI_PATTY_BG_TIMEOUT_MS/.test(s)) throw new Error('threshold patch lost in rebase');" \
  && echo "threshold patch intact"

git push --force-with-lease origin main
git tag -f v<new-version>-pi15 && git push -f origin v<new-version>-pi15
```

Then update the pinned ref in `setup_pi_agent.sh` (`BACKGROUND_TASKS_SRC`) and
`pi-settings.json`.

Note: Pi does not `git pull` packages. Git sources are pinned; reconcile with
`pi update --extensions`, or just re-run `setup_pi_agent.sh`.

## Upstreaming

If upstream ever adds a configurable auto-background timeout, this fork can be
retired. A one-line issue requesting it is the cheapest path.

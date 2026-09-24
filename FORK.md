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

Attention states colour the **whole row**, not just the glyph. One coloured
character ahead of plain text is too easy to miss while scanning several rows —
which is exactly when an exception matters most:

| Row kind | Treatment |
|---|---|
| healthy running | glyph colour only — keeps a busy strip calm |
| stalled / failed | whole row in its slot colour |
| completed / killed | whole row dimmed |

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

The collapsed view is bounded by **lines**, not items: `STRIP_VISIBLE_LINES`
(default **3**, override with `PI_PATTY_STRIP_LINES`). The item budget is
*lines × columns* — see the responsive grid below. Clicking `▾ +N more` expands;
`▴ collapse` returns. The component overload has **no `MAX_WIDGET_LINES` guard**,
so this is the only bound on strip height — do not remove it without another.

### Stall state

`monitoring.ts` already detected stalled jobs, but the verdict was one-shot: it
messaged the agent and cancelled, persisting nothing. It now also invokes an
`onStall` callback and `lifecycle.ts` sets `job.stalled = true`, giving the strip
a real state to render instead of a log-mtime heuristic that would false-positive
on any legitimately quiet build.

### Responsive grid

Rows are laid out in columns sized from the live render width, so a wide terminal
spends its horizontal space instead of putting one task per line:

| width | columns | cell | detail chars |
|---|---|---|---|
| 60 | 1 | 60 | 37 |
| 80 | 1 | 80 | 57 |
| 120 | 2 | 60 | 37 |
| 160 | 3 | 53 | 30 |
| 200 | 4 | 50 | 27 |

`STRIP_MIN_CELL = 44` (narrower and a cell stops being readable, so use fewer
columns) and `STRIP_MAX_COLS = 4`. Detail truncates **last** because it is the
least critical field, so a long command degrades to `my_very_long_comma...`
rather than pushing the elapsed time out of the cell. The toggle line spans the
full width on its own row and is not part of the grid.

It also saves vertical space: eight jobs is eight lines at 60 columns but **three**
at 160 — which matters, because the component overload has no `MAX_WIDGET_LINES`
guard.

#### The collapse budget is LINES, not items

An item-based limit was wrong once columns existed: three items in three columns
is **one line**, so it hid work it had width to show. Vertical space is the real
resource, so the budget is expressed in lines and the item budget is derived from
it:

| width | columns | item budget |
|---|---|---|
| 60 | 1 | 3 |
| 120 | 2 | 6 |
| 160 | 3 | 9 |
| 200 | 4 | 12 |

At a single column this degenerates to the same floor of three items.

Because the budget depends on width, the slicing had to move out of `registry.ts`
(which has no width) into the widget component. `buildStripRows` now returns the
**full** ordered list, and the component's `layout(width)` is the single source of
truth for what is visible — called by **both** `render()` and `hitAt()`. Two
independent computations of that list is exactly the bug class that produced the
press/click double-fire and the unreachable-rows counter.

**The mouse mapping changed.** `y` is a LINE and `x` selects the cell:

```
index = y * columnCount(width) + floor(x / cellWidth(width))
```

`press` records the resolved *target*, not the raw coordinates, so a relayout
between press and click cannot point at a neighbouring cell.

### Status-line counters must not double-count

`stalled` *refines* `running`, so a plain `status === "running"` filter includes
stalled jobs. The strip split them into separate buckets, but the status line did
not — so two stalled jobs rendered as `▶ 2 running · ⚠ 2 stalled`, reporting four
jobs when there were two, and claiming live work that did not exist.

The counters are now disjoint (`running` excludes stalled), while a separate
`liveCount` — running **and** stalled — drives the ticker, so elapsed times keep
counting on a stalled row even when no healthy work is running.

### Inline expand vs modal

A row has two click zones: the **glyph** expands the job inline, the **name**
opens the modal. Within a cell the glyph occupies the first two columns, so the
zone is `event.x - slotInLine * cellWidth < 2`.

Inline placement has to be done by the component itself. `ctx.ui.custom()`
*"temporarily gives one component control of the interactive area"* — and that
area sits **below** the widget, so a custom panel can only ever appear under the
whole list, never under the clicked row. Drawing the detail inside the strip is
the only way to put it where the user clicked.

With multiple columns there is no "below the clicked row" — the row shares a line
with others. Two attempts failed before the current one:

1. **Detail under the shared grid line** — expanding the *second* column appeared
to change only the **content** of a block still sitting under the first.
2. **The expanded row breaks out to a full-width line** — anchored the detail, but
reflowed the neighbours, and any reflow on expand/navigate reads as a glitch.
3. **Whole strip forced to one column** — anchored the detail but reflowed
everything. Worse than the problem.

The grid is now **RIGID**: the expanded row keeps its cell, and the detail is
inserted below the grid **line** holding it. Nothing moves on expand or on
`j`/`k` navigation within a line — the content changes in place. No-shift turned
out to be the stronger requirement than per-cell anchoring, so the detail is
attributed by the **job name on its meta line** rather than by position:

```
 ▼ alpha      5s   tick 0      ▶ bravo    5s   tick 1     ← grid intact, 2 cols
    ↳ alpha · running · 5s
    ↳ alpha tick 3
      esc close · j/k switch · x kill · o modal
 ▶ charlie    5s   tick 2      ▶ delta    5s   tick 3
```

Because the layout is mixed in principle, each grid line still carries **its own
cell width**, and `hitAt()` reads that per-line width.

The expanded row shows a **down-chevron (`▼`)** in place of the left-chevron.
Re-clicking collapses it, but with an identical glyph for both states that was
undiscoverable.

There is **no name zone**. A click anywhere on a row toggles it. Routing the name
click to a modal conflicted with a keybinding and **stole keyboard focus**, which
is what made the expand keys stop responding. The modal returns later via `o` /
Enter only.

#### The detail is indented to its cell

The block is indented by `slotInLine × cellWidth`, so it sits under the expanded
cell rather than always at column 0. The detail's available width becomes
`width - indent`, which in practice lands around 47-57 usable columns because
`cellWidth` is already 50-60:

| layout | indent, last column | detail width |
|---|---|---|
| 2 col @ 120 | 60 | ~57 |
| 3 col @ 160 | ~106 | ~51 |
| 4 col @ 200 | 150 | ~47 |

#### The no-shift invariant

> Given the same jobs, the rendered **line count** and every grid line's **y
> position** are identical regardless of *which* row is expanded. Only the
> detail's **x indent** varies.

Four mechanisms hold it. Two were broken before this change:

1. **The block is FIXED HEIGHT** — `DETAIL_TAIL_LINES + 2` (meta + tail + hint, 5
   lines). `stripDetail` returns as little as one line for a fresh or failed job,
   so without padding, navigating from a chatty job to a quiet one shrank the
   block and shifted everything below. The component pads **and** truncates, so
   the height holds even when `detail()` returns nothing or throws.
2. **`j`/`k` walk VISIBLE rows only.** They used the full row list, so enough
   presses expanded a row hidden behind `▾ +N more` — which renders no detail
   and silently removed five lines. `handleInput` has no width, so the component
   caches the last render width and budgets against it.
3. **Every detail line is truncated, never wrapped** — a wrapped line would add a
   rendered line.
4. **Only the indent varies.**

The detail's **y** does follow its grid *line*, so rows on line 1 place the block
one line lower than rows on line 0. That is inherent and correct; the invariant is
that nothing varies *within* a line.

Tested by rendering once per visible row expanded and asserting line count, grid
geometry and block height are invariant — systematic over hand-picked cases, the
same shape that caught the line-map bug.

A detail block occupies **several rendered lines**, so the line map stores its
rendered lines rather than a row index, and `hitAt()` walks the map **accumulating
rendered heights**. Indexing `lines[event.y]` directly is wrong for every `y`
below a detail block — a click resolves to whatever happens to sit at that map
index rather than what was drawn there. Covering *every* rendered line in the test
(not hand-picked indices) is what catches this class.

This also forced `layout()` to grow into a real line map (`grid` / `detail` /
`toggle`) rather than a flat row list. The hit-test walks that same map, so a
click can never land on a row that moved.

### Keyboard requires focus

`handleInput` is only called while the component **has focus**, and a mouse
handler can claim it:

```ts
// TuiMouseEventResult
/** Give keyboard focus to this component. Implies handled. */
focus?: boolean;
```

So a glyph click takes focus, the component implements `Focusable`, and `esc`
releases it with `tui.setFocus(null)`.

**The risk:** while focused, the editor does not receive keystrokes. Focus is
released unconditionally on `esc`/`q`, and the hint line always ends with
`esc close` so the way out is never hidden.

`esc` is matched with `matchesKey(data, "escape")`, never a raw `"\u001b"`
compare. A bare ESC is the prefix byte of every escape sequence and is reported
differently under the Kitty protocol — a raw compare silently never matches,
which is exactly why `q` worked and `esc` did not.

| Key | Action |
|---|---|
| `esc` / `q` | collapse, release focus |
| `j` / `↓` | expand next job |
| `k` / `↑` | expand previous |
| `x` | kill the expanded job |
| `o` / `Enter` | open the modal |

Deferred: `r` re-run, `a` acknowledge, `g`/`G` detail scroll.

### Mouse click contract

Pi delivers **both** a `press` and a `click` for one physical click. Handling each
independently fired the action twice, and the second pass read the row list *after*
the first pass had mutated it — so clicking `▾ +N more` expanded **and** opened
whichever job had landed on that row index. `handleMouse` now mirrors Pi's
`SelectList`: `press` records the row index, `click` activates using it.

### Stalled jobs are pinned

A stalled job is blocked on a human and will never produce another byte, so it is
an **outstanding decision** — not in-flight work. It is therefore its own bucket,
outside the collapse slice, exactly like failures: the limit cannot hide it.

Before this it competed for visible slots as ordinary running work, so a stalled
job could sit behind `+N more` while yellow — invisible precisely when it needed
attention.

The distinction matters because a merely *quiet* job is usually still working (a
long compile emits nothing for minutes). Patty only flags a stall when output
stops growing **and** the tail matches an interactive-prompt pattern (`(y/n)`,
`Overwrite?`, `Continue?` …), which means the job is waiting on input that will
never arrive.

### Collapse count

The toggle counts what expansion *would* reveal, not merely what is hidden at that
instant. The `quiet` (completed/killed) rows are empty while collapsed, so
comparing against the rendered row count alone reported "nothing hidden" and left
those jobs with no affordance to reach them.

```sh
PI_PATTY_STRIP_LINES=5 pi    # allow 5 lines before collapsing
```

## Environment override

```sh
PI_PATTY_BG_TIMEOUT_MS=10000 pi    # 10s
PI_PATTY_BG_TIMEOUT_MS=30000 pi    # 30s
```

Unset or non-positive values fall back to 15s.

## Install

```sh
pi install git:github.com/tomkhoailang/pi-patty-bg-tasks@v1.6.4-pi15
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

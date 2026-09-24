/**
 * Clickable strip widget — the background-task bar shown above the editor.
 *
 * Pi's `setWidget` accepts either a `string[]` or a component factory. The
 * string form is capped at 10 lines and cannot receive pointer events, so this
 * module uses the component form: each rendered line is a click target.
 *
 * A click anywhere on a row toggles it inline. There is deliberately no name
 * zone: routing a name click to a modal conflicted with a keybinding and stole
 * keyboard focus, which broke the expand keys. The modal returns via `o`/Enter.
 *
 * Row hit-testing mirrors Pi's own `SelectList`: `TuiMouseEvent.y` is zero-based
 * and local to the receiving component. `layout()` is the single source of truth
 * for what is drawn, and BOTH `render()` and `hitAt()` read it — computing the
 * visible set twice is the bug class behind the press/click double-fire and the
 * unreachable-rows counter.
 *
 * Events we do not claim return `undefined` rather than `{ handled: true }`, so
 * Pi keeps its fallbacks: a primary-button drag stays available for transcript
 * selection and wheel events still scroll.
 */

import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
    Job,
    StripActions,
    StripMouseEvent,
    StripMouseResult,
    StripRow,
    StripState,
    StripTheme,
    StripTui,
    StripWidgetComponent,
    UiContext,
} from "./types.ts";

/**
 * How many LINES the collapsed strip may occupy.
 *
 * The item budget is this times the column count, so a wide terminal uses the
 * width it has instead of showing three items on one line. At a single column
 * that is the floor of three items. Override with PI_PATTY_STRIP_LINES. The
 * component overload has no MAX_WIDGET_LINES guard, so this is the only bound
 * on strip height.
 */
const ENV_LINES = Number(process.env.PI_PATTY_STRIP_LINES);
export const STRIP_VISIBLE_LINES =
    Number.isFinite(ENV_LINES) && ENV_LINES > 0 ? Math.min(Math.floor(ENV_LINES), 10) : 3;

/** State → glyph + Pi theme slot. */
const STATE_STYLE: Record<StripState, { glyph: string; slot: string }> = {
    running: { glyph: "▶", slot: "accent" },
    stalled: { glyph: "▶", slot: "warning" },
    completed: { glyph: "✓", slot: "success" },
    failed: { glyph: "✗", slot: "error" },
    killed: { glyph: "⊘", slot: "muted" },
};

/** Terminal states are past tense — render them de-emphasised. */
const QUIET_STATES: ReadonlySet<StripState> = new Set(["completed", "killed"]);

/**
 * States that are an EXCEPTION rather than normal progress. These colour the
 * WHOLE row, not just the glyph: one coloured character ahead of plain text is
 * too easy to miss while scanning several rows. Healthy running jobs stay
 * glyph-only so a busy strip stays calm — the row is loud only when something
 * actually needs a decision.
 */
const LOUD_STATES: ReadonlySet<StripState> = new Set(["stalled", "failed"]);

// --- Responsive grid -------------------------------------------------------

/** Narrower than this and a cell stops being readable, so use fewer columns. */
const STRIP_MIN_CELL = 44;
/** Ceiling on columns, so an ultrawide terminal does not shred the row. */
const STRIP_MAX_COLS = 4;
/**
 * Log lines in the inline detail block. The block's height is FIXED at this
 * plus a meta line and a key-hint line, so navigating between jobs can never
 * change how many lines the strip occupies.
 */
export const DETAIL_TAIL_LINES = 3;
/** Fixed sub-columns inside a cell, so elapsed time aligns down a column. */
const STRIP_NAME_W = 12;
const STRIP_ELAPSED_W = 5;
/** Gutter between cells — the padding that separates one column from the next. */
const STRIP_GAP = 2;

type StripJobRow = Extract<StripRow, { kind: "job" }>;

/** What is on one rendered line. Built once in layout(), read by render + hit. */
type StripLine =
    | { kind: "grid"; rowIndices: number[]; cellW: number }
    | { kind: "detail"; lines: string[] }
    | { kind: "toggle" };

/** What a click landed on. */
type StripHit = { kind: "job"; row: StripJobRow } | { kind: "toggle" };

/** Cells per line for a given width. */
function columnCount(width: number): number {
    return Math.max(1, Math.min(STRIP_MAX_COLS, Math.floor(width / STRIP_MIN_CELL)));
}

/** Fixed cell width for that column count — cells stay uniform, not ragged. */
function cellWidth(width: number): number {
    return Math.max(1, Math.floor(width / columnCount(width)));
}

/** Truncate to `w` columns and pad back out to exactly `w`. */
function fit(text: string, w: number): string {
    const t = truncateToWidth(text, w);
    return t + " ".repeat(Math.max(0, w - visibleWidth(t)));
}

/** Pad a styled cell out to the full cell width; the padding is the gutter. */
function padTo(cell: string, w: number): string {
    return cell + " ".repeat(Math.max(0, w - visibleWidth(cell)));
}

/** matchesKey throws on an unknown key id; treat that as "no match". */
function isKey(data: string, key: string): boolean {
    try {
        return matchesKey(data, key as Parameters<typeof matchesKey>[1]);
    } catch {
        return false;
    }
}

class StripComponent implements StripWidgetComponent {
    /** Implements Focusable. Set by Pi when keyboard focus changes. */
    focused = false;

    // Plain fields, not constructor parameter properties: Pi loads extensions
    // through a TS transform whose feature support we do not control here.
    private readonly getRows: () => StripRow[];
    private readonly theme: StripTheme;
    private readonly actions: StripActions;
    private tui: StripTui | undefined;
    /** Width of the most recent render. handleInput() receives no width, and
     *  `j`/`k` must navigate the VISIBLE rows, which depend on it. */
    private lastWidth = 0;
    /** Target captured on press, consumed on click.
     *
     *  Pi delivers BOTH a `press` and a `click` for one physical click. Acting
     *  on each fired the action twice, and the second pass read the row list
     *  AFTER the first pass had mutated it — so clicking "+N more" expanded and
     *  then opened whichever job had landed on that row index. This mirrors
     *  Pi's SelectList: `press` records the target only, `click` activates. */
    private pressed: StripHit | undefined;

    constructor(getRows: () => StripRow[], theme: StripTheme, actions: StripActions) {
        this.getRows = getRows;
        this.theme = theme;
        this.actions = actions;
    }

    setTui(tui: StripTui): void {
        this.tui = tui;
    }

    /**
     * Everything render() and hitAt() need, computed once.
     *
     * Collapsed shows the first `STRIP_VISIBLE_LINES × columns` running rows.
     * Stalled and failed ride along WITHOUT consuming that budget, so healthy
     * work can never squeeze out an outstanding decision. Completed and killed
     * are expanded-only.
     */
    private layout(width: number): {
        rows: StripRow[];
        cols: number;
        lines: StripLine[];
        toggleText: string | undefined;
    } {
        const all = this.getRows();
        const cols = columnCount(width);
        const gridW = Math.max(1, Math.floor(width / cols));
        const rows = this.budgetedRows(all, cols);

        const expandedId = this.actions.expandedJobId();
        // Truthiness, not `!== undefined`: a falsy "no expansion" value must not
        // change the layout. (The field is typed string|undefined, but callers
        // using null would silently reflow the grid.)
        const hasExpansion = Boolean(expandedId);
        const detailAt = hasExpansion
            ? rows.findIndex((row) => row.kind === "job" && row.job.id === expandedId)
            : -1;

        // The grid stays RIGID: the expanded row keeps its cell and the detail
        // is inserted below the grid LINE that holds it. Breaking the row out to
        // a full-width line anchored the detail better but reflowed the
        // neighbours, and any reflow on expand/navigate reads as a glitch. No
        // shift is the stronger requirement, so the detail is attributed by the
        // job name on its meta line instead of by indentation.
        const lines: StripLine[] = [];
        for (let i = 0; i < rows.length; i += cols) {
            const rowIndices: number[] = [];
            for (let c = 0; c < cols && i + c < rows.length; c++) rowIndices.push(i + c);
            lines.push({ kind: "grid", rowIndices, cellW: gridW });

            if (detailAt >= 0 && Math.floor(detailAt / cols) === Math.floor(i / cols)) {
                const row = rows[detailAt];
                if (row && row.kind === "job") {
                    // Indent to the expanded cell's column, and render here once:
                    // hitAt needs the height, and rendering twice would read the
                    // log twice.
                    const indent = (detailAt - i) * gridW;
                    lines.push({ kind: "detail", lines: this.renderDetail(row.job, width, indent) });
                }
            }
        }

        let toggleText: string | undefined;
        if (!this.actions.listExpanded()) {
            const hidden = all.length - rows.length;
            if (hidden > 0) toggleText = `▾ +${hidden} more`;
        } else if (all.length > STRIP_VISIBLE_LINES * cols) {
            toggleText = "▴ collapse";
        }
        if (toggleText) lines.push({ kind: "toggle" });

        return { rows, cols, lines, toggleText };
    }

    /** Apply the line budget to the full row list. */
    private budgetedRows(all: StripRow[], cols: number): StripRow[] {
        if (this.actions.listExpanded() || all.length === 0) return all;

        const budget = STRIP_VISIBLE_LINES * cols;
        const pinned = new Set<StripRow>();
        let runningSeen = 0;

        for (const row of all) {
            if (row.kind === "toggle") continue;
            if (row.state === "stalled" || row.state === "failed") {
                pinned.add(row);
                continue;
            }
            if (row.state !== "running") continue;
            runningSeen++;
            if (runningSeen <= budget) pinned.add(row);
        }
        return all.filter((row) => pinned.has(row));
    }

    render(width: number): string[] {
        const { rows, lines, toggleText } = this.layout(width);
        this.lastWidth = width;

        const out: string[] = [];
        for (const line of lines) {
            if (line.kind === "toggle") {
                if (toggleText) out.push(truncateToWidth(this.theme.fg("dim", toggleText), width));
                continue;
            }
            if (line.kind === "detail") {
                out.push(...line.lines);
                continue;
            }
            const contentW = Math.max(1, line.cellW - STRIP_GAP);
            let text = "";
            for (const index of line.rowIndices) {
                text += padTo(this.renderJob(rows[index] as StripJobRow, contentW), line.cellW);
            }
            out.push(text.replace(/ +$/, ""));
        }
        return out;
    }

    /** One cell: glyph + name, elapsed, then detail (truncated last). */
    private renderJob(row: StripJobRow, contentW: number): string {
        const { glyph, slot } = STATE_STYLE[row.state];
        // The expanded row shows a down-chevron: the same left-chevron for both
        // states gave no visual cue that the row was open, so re-clicking to
        // collapse was undiscoverable.
        const marker = this.actions.expandedJobId() === row.job.id ? "▼" : glyph;
        const head = this.theme.fg(slot, marker);
        const bodyPlain = `${fit(row.name, STRIP_NAME_W)} ${fit(row.elapsed, STRIP_ELAPSED_W)} ${row.detail}`;
        const body = QUIET_STATES.has(row.state)
            ? this.theme.fg("dim", bodyPlain)
            : LOUD_STATES.has(row.state)
              ? this.theme.fg(slot, bodyPlain)
              : bodyPlain;
        return truncateToWidth(`${head} ${body}`, contentW);
    }

    /**
     * The inline block under the expanded row: bounded log tail, then the key
     * hint, indented to the expanded cell's column.
     *
     * Height is FIXED. A short log (or a failed `detail()` call) pads to the same
     * number of lines as a long one, so navigating between jobs cannot change the
     * strip's height and shift everything below.
     */
    private renderDetail(job: Job, width: number, indent: number): string[] {
        const pad = " ".repeat(indent);
        const raw = this.actions.detail(job);
        const out: string[] = [];

        // meta line + tail lines (the registry returns both), then the hint. The
        // loop bound must include the meta, or the last tail line is dropped.
        for (let i = 0; i < DETAIL_TAIL_LINES + 1; i++) {
            const line = raw[i];
            out.push(
                line
                    ? truncateToWidth(pad + this.theme.fg("dim", `   ↳ ${line}`), width)
                    : ""
            );
        }
        out.push(
            truncateToWidth(
                pad + this.theme.fg("dim", "     esc close · j/k switch · x kill · o modal"),
                width
            )
        );
        return out;
    }

    /**
     * Map a mouse position to whatever is under it.
     *
     * Columns change this mapping: `y` is a LINE and `x` selects the cell
     * within it. Which line holds what comes from layout(), so the hit-test can
     * never disagree with what was drawn.
     */
    private hitAt(event: StripMouseEvent): StripHit | undefined {
        const { rows, lines } = this.layout(event.width);

        // Walk the map accumulating RENDERED heights. A detail entry occupies
        // several lines, so `lines[event.y]` directly would be wrong for every y
        // below one — a click would resolve to the row that happens to sit at
        // that index in the map rather than the one drawn there.
        let acc = 0;
        let line: StripLine | undefined;
        for (const entry of lines) {
            const height = entry.kind === "detail" ? entry.lines.length : 1;
            if (event.y < acc + height) {
                line = entry;
                break;
            }
            acc += height;
        }
        if (!line) return undefined;
        if (line.kind === "toggle") return { kind: "toggle" };
        if (line.kind === "detail") return undefined;

        const slotInLine = Math.floor(event.x / line.cellW);
        const index = line.rowIndices[slotInLine];
        if (index === undefined) return undefined;

        const row = rows[index];
        if (!row || row.kind !== "job") return undefined;

        // Any click on the row toggles it. There is no name zone: sending the
        // name click to a modal conflicted with a keybinding and stole keyboard
        // focus, which is what made the expand keys stop responding. The modal
        // returns later via `o` / Enter only.
        return { kind: "job", row };
    }

    handleMouse(event: StripMouseEvent): StripMouseResult | undefined {
        // Wheel: decline so Pi scrolls whatever is under the pointer.
        if (event.type === "wheel") return undefined;
        // Only a left press/click is ours; right/middle stay unhandled.
        if (event.button !== "left") return undefined;
        if (event.type !== "press" && event.type !== "click") return undefined;

        // Record the resolved TARGET on press, not the raw coordinates: the
        // layout is derived from width, so stale coordinates could resolve to a
        // different cell on release.
        if (event.type === "press") {
            this.pressed = this.hitAt(event);
            return { handled: true };
        }

        const hit = this.pressed ?? this.hitAt(event);
        this.pressed = undefined;
        if (hit === undefined) return undefined;

        if (hit.kind === "toggle") {
            this.actions.toggleList();
            return { handled: true };
        }

        // Expanding is the keyboard-driven mode, so claim focus with it —
        // `esc`, `j`/`k` and `x` only reach us while we hold it.
        const current = this.actions.expandedJobId();
        const same = Boolean(current) && current === hit.row.job.id;
        this.actions.expand(same ? undefined : hit.row.job.id);
        if (same) this.releaseFocus();
        return { handled: true, focus: !same };
    }

    /** Job rows the current width actually shows. `j`/`k` must not reach rows
     *  hidden behind the toggle: expanding one would render no detail block and
     *  the strip would lose its lines. */
    private visibleJobRows(): StripJobRow[] {
        const cols = columnCount(this.lastWidth);
        return this.budgetedRows(this.getRows(), cols).filter(
            (row): row is StripJobRow => row.kind === "job"
        );
    }

    /**
     * Keys, live only while focused. `esc` is checked with matchesKey rather
     * than a raw "\u001b" compare — a bare ESC is the prefix byte of every
     * escape sequence and is reported differently under the Kitty protocol,
     * which is why a raw compare silently never matched.
     */
    handleInput(data: string): void {
        if (isKey(data, "escape") || data === "q") {
            this.actions.expand(undefined);
            this.releaseFocus();
            return;
        }

        const jobs = this.visibleJobRows();
        if (jobs.length === 0) return;

        const current = this.actions.expandedJobId();
        const at = current === undefined ? -1 : jobs.findIndex((row) => row.job.id === current);

        if (data === "j" || isKey(data, "down")) {
            const next = jobs[at < 0 ? 0 : (at + 1) % jobs.length];
            if (next) this.actions.expand(next.job.id);
            return;
        }
        if (data === "k" || isKey(data, "up")) {
            const prev = jobs[at <= 0 ? jobs.length - 1 : at - 1];
            if (prev) this.actions.expand(prev.job.id);
            return;
        }

        const selected = at >= 0 ? jobs[at] : undefined;
        if (!selected) return;

        if (data === "x") {
            this.actions.kill(selected.job);
            return;
        }
        if (data === "o" || isKey(data, "enter")) {
            this.actions.select(selected.job);
        }
    }

    /** Hand keyboard focus back to the editor. */
    private releaseFocus(): void {
        try {
            this.tui?.setFocus(null);
        } catch {
            /* stale handle — the next install recreates it */
        }
    }

    invalidate(): void {
        // Nothing cached: rows are rebuilt from live registry state on render.
    }
}

/**
 * Build the widget factory for `setWidget`'s component overload.
 *
 * @param getRows  Live row supplier, read on every render.
 * @param theme    Pi theme, used for semantic slot colours.
 * @param actions  Callbacks for expand / select / kill / list toggle.
 * @param onHandle Receives the TUI handle so the caller can request renders.
 */
export function createStripWidget(
    getRows: () => StripRow[],
    theme: StripTheme,
    actions: StripActions,
    onHandle: (tui: StripTui) => void
): (tui: StripTui, theme: StripTheme) => StripWidgetComponent {
    return (tui: StripTui, factoryTheme: StripTheme) => {
        onHandle(tui);
        const component = new StripComponent(getRows, factoryTheme ?? theme, actions);
        component.setTui(tui);
        return component;
    };
}

/**
 * Modal panel opened by clicking a row's name (or `o` / Enter while expanded).
 *
 * Inline expansion is the primary mode; this stays a placeholder for the
 * full-screen view that will carry search and filtering.
 */
export async function openStripPanel(job: Job, ctx: UiContext): Promise<void> {
    // Custom components are terminal-only (Pi's own guard for ctx.ui.custom).
    if (ctx.mode !== "tui") return;

    const custom = ctx.ui.custom;
    if (typeof custom !== "function") {
        ctx.ui.notify(`▶ ${job.name ?? job.id} · ${job.status}`, "info");
        return;
    }

    const body = [
        `▶ ${job.name ?? job.id} · ${job.status}`,
        "",
        "        (empty — wired up next)",
        "",
        "  esc or q to close",
    ];

    await custom((_tui, _theme, _kb, done) => ({
        render: (width: number) => body.map((line) => truncateToWidth(line, width)),
        invalidate: () => {},
        handleInput: (data: string) => {
            if (isKey(data, "escape") || data === "q" || isKey(data, "enter")) done(undefined);
        },
    }));
}

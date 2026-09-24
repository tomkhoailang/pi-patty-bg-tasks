/**
 * Clickable strip widget — the background-task bar shown above the editor.
 *
 * Pi's `setWidget` accepts either a `string[]` or a component factory. The
 * string form is capped at 10 lines and cannot receive pointer events, so this
 * module uses the component form: each rendered line is a click target.
 *
 * Hit-testing mirrors Pi's own `SelectList`: `TuiMouseEvent.y` is zero-based and
 * already local to the receiving component, so row N is simply `rows[event.y]`.
 *
 * Events we do not claim return `undefined` rather than `{ handled: true }`, so
 * Pi keeps its fallbacks:
 *   - a primary-button drag stays available for transcript selection
 *   - wheel events still scroll the transcript
 * Only a left press/click on an occupied row is claimed.
 *
 * Styling uses Pi's semantic theme slots, so the strip follows the active theme
 * rather than hard-coded colours. `truncateToWidth` (not code-point slicing) is
 * required because rows now contain ANSI sequences.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
    Job,
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
 * How many rows the strip shows before collapsing behind a "+N more" line.
 * Override with PI_PATTY_STRIP_LIMIT. Clamped to a sane range: 0 or garbage
 * falls back to 3, and anything above 20 is capped so the strip cannot eat the
 * viewport (the component overload has no MAX_WIDGET_LINES guard).
 */
const ENV_LIMIT = Number(process.env.PI_PATTY_STRIP_LIMIT);
export const STRIP_VISIBLE_LIMIT =
    Number.isFinite(ENV_LIMIT) && ENV_LIMIT > 0 ? Math.min(Math.floor(ENV_LIMIT), 20) : 3;

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
/** Fixed sub-columns inside a cell, so elapsed time aligns down a column. */
const STRIP_NAME_W = 12;
const STRIP_ELAPSED_W = 5;
/** Gutter between cells — the padding that separates one column from the next. */
const STRIP_GAP = 2;

type StripJobRow = Extract<StripRow, { kind: "job" }>;

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

class StripComponent implements StripWidgetComponent {
    // Plain fields, not constructor parameter properties: Pi loads extensions
    // through a TS transform whose feature support we do not control here.
    private readonly getRows: () => StripRow[];
    private readonly theme: StripTheme;
    private readonly onSelect: (job: Job) => void;
    private readonly onToggle: () => void;
    /** Row index captured on press, consumed on click.
     *
     *  Pi delivers BOTH a `press` and a `click` for one physical click. Acting
     *  on each fired the action twice, and the second pass read the row list
     *  AFTER the first pass had mutated it — so clicking "+N more" expanded and
     *  then opened whichever job had landed on that row index. This mirrors
     *  Pi's SelectList: `press` records position only, `click` activates. */
    private pressedIndex: number | undefined;

    constructor(
        getRows: () => StripRow[],
        theme: StripTheme,
        onSelect: (job: Job) => void,
        onToggle: () => void
    ) {
        this.getRows = getRows;
        this.theme = theme;
        this.onSelect = onSelect;
        this.onToggle = onToggle;
    }

    render(width: number): string[] {
        const rows = this.getRows();
        if (rows.length === 0) return [];

        // The toggle always sits last and spans the full width, so it is not
        // part of the grid.
        const last = rows[rows.length - 1];
        const toggle = last.kind === "toggle" ? last : undefined;
        const jobs = toggle ? rows.slice(0, -1) : rows;

        const cols = columnCount(width);
        const cw = cellWidth(width);
        const contentW = Math.max(1, cw - STRIP_GAP);

        const lines: string[] = [];
        for (let i = 0; i < jobs.length; i += cols) {
            let line = "";
            for (let c = 0; c < cols && i + c < jobs.length; c++) {
                line += padTo(this.renderJob(jobs[i + c] as StripJobRow, contentW), cw);
            }
            lines.push(line.replace(/ +$/, ""));
        }

        if (toggle) lines.push(truncateToWidth(this.theme.fg("dim", toggle.text), width));
        return lines;
    }

    /** One cell: coloured glyph + name, elapsed, then detail (truncated last). */
    private renderJob(row: StripJobRow, contentW: number): string {
        const { glyph, slot } = STATE_STYLE[row.state];
        const head = this.theme.fg(slot, glyph);
        const bodyPlain = `${fit(row.name, STRIP_NAME_W)} ${fit(row.elapsed, STRIP_ELAPSED_W)} ${row.detail}`;
        const body = QUIET_STATES.has(row.state)
            ? this.theme.fg("dim", bodyPlain)
            : LOUD_STATES.has(row.state)
              ? this.theme.fg(slot, bodyPlain)
              : bodyPlain;
        return truncateToWidth(`${head} ${body}`, contentW);
    }

    /**
     * Map a mouse position to a row index.
     *
     * Columns change this mapping: `y` is now a LINE and `x` selects the cell
     * within it. The toggle spans the full width on its own line, so it is
     * matched by line rather than by cell.
     */
    private rowIndexAt(event: StripMouseEvent): number | undefined {
        const rows = this.getRows();
        if (rows.length === 0) return undefined;

        const hasToggle = rows[rows.length - 1].kind === "toggle";
        const jobCount = hasToggle ? rows.length - 1 : rows.length;

        const cols = columnCount(event.width);
        const cw = cellWidth(event.width);
        const jobLines = Math.ceil(jobCount / cols);

        if (event.y >= jobLines) {
            return hasToggle && event.y === jobLines ? rows.length - 1 : undefined;
        }
        const index = event.y * cols + Math.floor(event.x / cw);
        return index < jobCount ? index : undefined;
    }

    handleMouse(event: StripMouseEvent): StripMouseResult | undefined {
        // Wheel: decline so Pi scrolls whatever is under the pointer.
        if (event.type === "wheel") return undefined;
        // Only a left press/click is ours; right/middle stay unhandled.
        if (event.button !== "left") return undefined;
        if (event.type !== "press" && event.type !== "click") return undefined;

        // Record the resolved ROW index on press, not the raw line: the layout
        // is recomputed from width, so a stale y could point at another cell.
        if (event.type === "press") {
            this.pressedIndex = this.rowIndexAt(event);
            return { handled: true };
        }

        const index = this.pressedIndex ?? this.rowIndexAt(event);
        this.pressedIndex = undefined;
        if (index === undefined) return undefined;

        const row = this.getRows()[index];
        if (!row) return undefined;

        if (row.kind === "toggle") this.onToggle();
        else this.onSelect(row.job);
        return { handled: true };
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
 * @param onSelect Invoked with the clicked job row.
 * @param onToggle Invoked when the collapse/expand line is clicked.
 * @param onHandle Receives the TUI handle so the caller can request renders.
 */
export function createStripWidget(
    getRows: () => StripRow[],
    theme: StripTheme,
    onSelect: (job: Job) => void,
    onToggle: () => void,
    onHandle: (tui: StripTui) => void
): (tui: StripTui, theme: StripTheme) => StripWidgetComponent {
    return (tui: StripTui, factoryTheme: StripTheme) => {
        onHandle(tui);
        return new StripComponent(getRows, factoryTheme ?? theme, onSelect, onToggle);
    };
}

/**
 * Placeholder panel opened by clicking a strip row.
 *
 * Milestone 0: proves the click path end-to-end. The body is intentionally
 * empty — rows, live tail and actions come next.
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
            if (data === "\u001b" || data === "q" || data === "\r" || data === "\n") {
                done(undefined);
            }
        },
    }));
}

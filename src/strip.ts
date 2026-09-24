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
    private readonly isExpanded: () => boolean;
    /** Target captured on press, consumed on click.
     *
     *  Pi delivers BOTH a `press` and a `click` for one physical click. Acting
     *  on each fired the action twice, and the second pass read the row list
     *  AFTER the first pass had mutated it — so clicking "+N more" expanded and
     *  then opened whichever job had landed on that row index. This mirrors
     *  Pi's SelectList: `press` records the target only, `click` activates. */
    private pressedTarget: StripRow | "toggle" | undefined;

    constructor(
        getRows: () => StripRow[],
        theme: StripTheme,
        onSelect: (job: Job) => void,
        onToggle: () => void,
        isExpanded: () => boolean
    ) {
        this.getRows = getRows;
        this.theme = theme;
        this.onSelect = onSelect;
        this.onToggle = onToggle;
        this.isExpanded = isExpanded;
    }

    /**
     * Rows to draw, plus the toggle line when one applies.
     *
     * render() and hitAt() BOTH go through here, so the drawn layout and the
     * hit-test can never disagree about which rows are visible. That
     * inconsistency is exactly the bug class that produced the press/click
     * double-fire and the unreachable-rows counter.
     *
     * Collapsed shows the first `STRIP_VISIBLE_LINES × columns` running rows.
     * Stalled and failed ride along WITHOUT consuming that budget, so healthy
     * work can never squeeze out an outstanding decision. Completed and killed
     * are expanded-only.
     */
    private layout(width: number): { rows: StripRow[]; toggle: string | undefined } {
        const all = this.getRows();
        const expanded = this.isExpanded();
        const budget = STRIP_VISIBLE_LINES * columnCount(width);

        let runningSeen = 0;
        const rows = expanded
            ? all
            : all.filter((row) => {
                  if (row.kind === "toggle") return false;
                  if (row.state === "stalled" || row.state === "failed") return true;
                  if (row.state === "running") return ++runningSeen <= budget;
                  return false;
              });

        let toggle: string | undefined;
        if (!expanded) {
            const hidden = all.length - rows.length;
            if (hidden > 0) toggle = `▾ +${hidden} more`;
        } else if (all.length > budget) {
            toggle = "▴ collapse";
        }
        return { rows, toggle };
    }

    render(width: number): string[] {
        const { rows, toggle } = this.layout(width);
        if (rows.length === 0 && toggle === undefined) return [];

        const cols = columnCount(width);
        const cw = cellWidth(width);
        const contentW = Math.max(1, cw - STRIP_GAP);

        const lines: string[] = [];
        for (let i = 0; i < rows.length; i += cols) {
            let line = "";
            for (let c = 0; c < cols && i + c < rows.length; c++) {
                line += padTo(this.renderJob(rows[i + c] as StripJobRow, contentW), cw);
            }
            lines.push(line.replace(/ +$/, ""));
        }

        // The toggle spans the full width on its own line, outside the grid.
        if (toggle) lines.push(truncateToWidth(this.theme.fg("dim", toggle), width));
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
     * Map a mouse position to whatever is under it.
     *
     * Columns change this mapping: `y` is a LINE and `x` selects the cell
     * within it. The toggle spans the full width on its own line, so it is
     * matched by line rather than by cell.
     */
    private hitAt(event: StripMouseEvent): StripRow | "toggle" | undefined {
        const { rows, toggle } = this.layout(event.width);
        const cols = columnCount(event.width);
        const cw = cellWidth(event.width);
        const jobLines = Math.ceil(rows.length / cols);

        if (event.y >= jobLines) {
            return toggle !== undefined && event.y === jobLines ? "toggle" : undefined;
        }
        const index = event.y * cols + Math.floor(event.x / cw);
        return index < rows.length ? rows[index] : undefined;
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
            this.pressedTarget = this.hitAt(event);
            return { handled: true };
        }

        const target = this.pressedTarget ?? this.hitAt(event);
        this.pressedTarget = undefined;
        if (target === undefined) return undefined;

        if (target === "toggle") this.onToggle();
        else this.onSelect(target.job);
        return { handled: true };
    }

    invalidate(): void {
        // Nothing cached: rows are rebuilt from live registry state on render.
    }
}

/**
 * Build the widget factory for `setWidget`'s component overload.
 *
 * @param getRows    Live row supplier, read on every render.
 * @param theme      Pi theme, used for semantic slot colours.
 * @param onSelect   Invoked with the clicked job row.
 * @param onToggle   Invoked when the collapse/expand line is clicked.
 * @param isExpanded Whether the strip is currently expanded.
 * @param onHandle   Receives the TUI handle so the caller can request renders.
 */
export function createStripWidget(
    getRows: () => StripRow[],
    theme: StripTheme,
    onSelect: (job: Job) => void,
    onToggle: () => void,
    isExpanded: () => boolean,
    onHandle: (tui: StripTui) => void
): (tui: StripTui, theme: StripTheme) => StripWidgetComponent {
    return (tui: StripTui, factoryTheme: StripTheme) => {
        onHandle(tui);
        return new StripComponent(getRows, factoryTheme ?? theme, onSelect, onToggle, isExpanded);
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

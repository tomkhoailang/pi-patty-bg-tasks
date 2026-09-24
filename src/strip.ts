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
 */

import { jobLabel } from "./format.ts";
import type {
    Job,
    StripMouseEvent,
    StripMouseResult,
    StripRow,
    StripTheme,
    StripTui,
    StripWidgetComponent,
    UiContext,
} from "./types.ts";

/**
 * Width-safe truncation. Rows are rendered as plain text (no ANSI), matching
 * the previous `string[]` widget's appearance and keeping this safe to slice by
 * code point — a coloured string could be cut mid-escape-sequence.
 */
function truncate(text: string, width: number): string {
    const chars = [...text];
    if (chars.length <= width) return text;
    if (width <= 1) return chars.slice(0, Math.max(0, width)).join("");
    return chars.slice(0, width - 1).join("") + "…";
}

class StripComponent implements StripWidgetComponent {
    // Plain fields, not constructor parameter properties: Pi loads extensions
    // through a TS transform whose feature support we do not control here.
    private readonly getRows: () => StripRow[];
    private readonly onSelect: (job: Job) => void;

    constructor(getRows: () => StripRow[], onSelect: (job: Job) => void) {
        this.getRows = getRows;
        this.onSelect = onSelect;
    }

    render(width: number): string[] {
        return this.getRows().map((row) => truncate(row.text, width));
    }

    handleMouse(event: StripMouseEvent): StripMouseResult | undefined {
        // Wheel: decline so Pi scrolls whatever is under the pointer.
        if (event.type === "wheel") return undefined;
        // Only a left press/click is ours; right/middle stay unhandled.
        if (event.button !== "left") return undefined;
        if (event.type !== "press" && event.type !== "click") return undefined;

        const row = this.getRows()[event.y];
        if (!row) return undefined;

        this.onSelect(row.job);
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
 * @param onSelect Invoked with the clicked row's job.
 * @param onHandle Receives the TUI handle so the caller can request renders.
 */
export function createStripWidget(
    getRows: () => StripRow[],
    _theme: StripTheme,
    onSelect: (job: Job) => void,
    onHandle: (tui: StripTui) => void
): (tui: StripTui, theme: StripTheme) => StripWidgetComponent {
    return (tui: StripTui) => {
        onHandle(tui);
        return new StripComponent(getRows, onSelect);
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
        ctx.ui.notify(`▶ ${jobLabel(job)} · ${job.status}`, "info");
        return;
    }

    const body = [
        `▶ ${jobLabel(job)} · ${job.status}`,
        "",
        "        (empty — wired up next)",
        "",
        "  esc or q to close",
    ];

    await custom((_tui, _theme, _kb, done) => ({
        render: (width: number) => body.map((line) => truncate(line, width)),
        invalidate: () => {},
        handleInput: (data: string) => {
            if (data === "\u001b" || data === "q" || data === "\r" || data === "\n") {
                done(undefined);
            }
        },
    }));
}

/**
 * Task Monitor — the two-pane background-task modal.
 *
 *   ┌ Task Monitor ────────────────────────────────────────────────┐
 *   │  [all] running completed failed killed   ↑↓ move · ⇥ filter   │
 *   ├─────────────────────────────┬────────────────────────────────┤
 *   │ ▶ cargo build  12:03  2m41s │ <selected task: header + output │
 *   └─────────────────────────────┴────────────────────────────────┘
 *
 * Left pane: a filterable task list (SelectList) — status tabs (1-5 or ⇥) plus
 * a typed search over name/command/id. Right pane: the selected task's live log
 * tail, scrollable. Mouse works on both panes; `x` kills, `c` copies the command,
 * `d` removes the task, `⏎` moves focus to/from the output pane.
 *
 * Opened via ctx.ui.custom(..., { overlay: true }). Terminal-only; the caller
 * falls back to openBgListPanel() elsewhere.
 */

import {
    SelectList,
    getNativeClipboard,
    matchesKey,
    truncateToWidth,
    visibleWidth,
} from "@earendil-works/pi-tui";
import type {
    Component,
    SelectItem,
    SelectListTheme,
    TuiMouseEvent,
    TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { BackgroundRegistry } from "./state.ts";
import { OUTPUT_PREVIEW_CHARS, PREVIEW_CHARS } from "./types.ts";
import type { Job, StripTheme, UiContext } from "./types.ts";
import { elapsedMs, formatDuration, jobLabel } from "./format.ts";
import { forget, readLogTail, renderSidebar } from "./registry.ts";
import { terminateJobSilently } from "./lifecycle.ts";
import { openBgListPanel } from "./ui.ts";

const FILTERS = ["all", "running", "completed", "failed", "killed"] as const;
export type TaskFilter = (typeof FILTERS)[number];

/** Rows in the body (list + output), and the SelectList window. */
const BODY_ROWS = 18;
/** Header + hint above the body; mouse y is offset by this. */
const HEADER_ROWS = 2;

const icon = (job: Job): string =>
    job.status === "running" ? (job.stalled ? "⏸" : "▶")
    : job.status === "completed" ? "✓"
    : job.status === "failed" ? "✗"
    : "⊘";

const time = (job: Job): string =>
    new Date(job.startTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const dur = (job: Job): string =>
    job.status === "running" ? formatDuration(elapsedMs(job)) : job.status;

const pad = (s: string, width: number): string =>
    s + " ".repeat(Math.max(0, width - visibleWidth(s)));

/** Open the task monitor. `initial` pre-selects a status filter tab. */
export async function openTaskMonitor(
    reg: BackgroundRegistry,
    ctx: UiContext,
    initial: TaskFilter = "all"
): Promise<void> {
    if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
        return openBgListPanel(reg, ctx);
    }
    await ctx.ui.custom<void>(
        (tui, theme, _kb, done) =>
            new TaskMonitor(
                reg,
                ctx,
                theme,
                () => (tui as { requestRender(): void }).requestRender(),
                done,
                initial
            ),
        { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: 28 } }
    );
}

export class TaskMonitor implements Component {
    private filter: TaskFilter;
    private query = "";
    private focus: "list" | "output" = "list";
    private outLines: string[] = [];
    private outScroll = 0;
    private outFollow = true;
    private lastWidth = 80;
    private list: SelectList;
    private readonly listTheme: SelectListTheme;

    private readonly reg: BackgroundRegistry;
    private readonly ctx: UiContext;
    private readonly theme: StripTheme;
    private readonly requestRender: () => void;
    private readonly done: (r?: void) => void;

    constructor(
        reg: BackgroundRegistry,
        ctx: UiContext,
        theme: StripTheme,
        requestRender: () => void,
        done: (r?: void) => void,
        initial: TaskFilter
    ) {
        this.reg = reg;
        this.ctx = ctx;
        this.theme = theme;
        this.requestRender = requestRender;
        this.done = done;
        this.filter = initial;
        this.listTheme = {
            selectedPrefix: (t) => this.theme.fg("accent", t),
            selectedText: (t) => this.theme.fg("accent", t),
            description: (t) => this.theme.fg("dim", t),
            scrollInfo: (t) => this.theme.fg("dim", t),
            noMatch: (t) => this.theme.fg("dim", t),
        };
        this.list = this.buildList();
        this.updateOutput();
    }

    // --- data ---------------------------------------------------------------

    private jobs(): Job[] {
        const q = this.query.toLowerCase();
        return [...this.reg.jobs.values()]
            .filter((j) => this.filter === "all" || j.status === this.filter)
            .filter(
                (j) =>
                    !q ||
                    (j.name ?? "").toLowerCase().includes(q) ||
                    j.command.toLowerCase().includes(q) ||
                    j.id.toLowerCase().includes(q)
            )
            .sort(
                (a, b) =>
                    Number(b.status === "running") - Number(a.status === "running") ||
                    b.startTime - a.startTime
            );
    }

    private buildList(): SelectList {
        const items: SelectItem[] = this.jobs().map((j) => ({
            value: j.id,
            label: `${icon(j)} ${jobLabel(j)}`,
            description: `${j.command.slice(0, PREVIEW_CHARS.taskList)} · ${time(j)} · ${dur(j)}`,
        }));
        const list = new SelectList(items, BODY_ROWS, this.listTheme, {
            minPrimaryColumnWidth: 12,
            maxPrimaryColumnWidth: 30,
        });
        list.invalidate();
        return list;
    }

    private selected(): Job | undefined {
        const item = this.list.getSelectedItem();
        return item ? this.reg.jobs.get(item.value) : undefined;
    }

    /** Rebuild the list (filter/search/action) preserving the selected id. */
    private rebuild(): void {
        const prev = this.list.getSelectedItem()?.value;
        const jobs = this.jobs();
        const idx = jobs.findIndex((j) => j.id === prev);
        this.list = this.buildList();
        this.list.onSelectionChange = () => { this.updateOutput(); this.requestRender(); };
        if (idx > 0) this.list.setSelectedIndex(idx);
        this.updateOutput();
        this.requestRender();
    }

    private updateOutput(): void {
        const job = this.selected();
        if (!job) {
            this.outLines = [this.theme.fg("dim", "  select a task")];
            return;
        }
        const tail = readLogTail(job, OUTPUT_PREVIEW_CHARS).replace(/\r/g, "");
        this.outLines = [
            `${icon(job)} ${jobLabel(job)}  ·  ${job.status}  ·  ${time(job)}  ·  ${dur(job)}`,
            `$ ${job.command}`,
            this.theme.fg("dim", "─".repeat(40)),
            ...tail.split("\n"),
        ];
        if (this.outFollow) {
            this.outScroll = Math.max(0, this.outLines.length - BODY_ROWS);
        }
    }

    private maxScroll(): number {
        return Math.max(0, this.outLines.length - BODY_ROWS);
    }

    // --- render -------------------------------------------------------------

    private leftWidth(width: number): number {
        return Math.max(30, Math.min(56, Math.round(width * 0.4)));
    }

    render(width: number): string[] {
        this.lastWidth = width;
        const leftW = this.leftWidth(width);
        const rightW = Math.max(20, width - leftW - 3);

        const tabs = FILTERS.map((f) =>
            f === this.filter ? this.theme.fg("accent", `[${f}]`) : this.theme.fg("dim", ` ${f} `)
        ).join("");
        const search = this.query ? `   search: ${this.theme.fg("accent", this.query)}` : "";
        const header = this.theme.fg("accent", " Task Monitor") + "  " + tabs + search;
        const hint = this.theme.fg(
            "dim",
            this.focus === "output"
                ? "  ↑↓/PgUp/PgDn scroll output · ⏎/esc back"
                : "  ↑↓ move · ⇥/1-5 filter · type to search · x kill · c copy · d remove · ⏎ output · esc close"
        );

        const left = this.list.render(leftW);
        const out: string[] = [header, hint];
        for (let i = 0; i < BODY_ROWS; i++) {
            const l = pad(truncateToWidth(left[i] ?? "", leftW, ""), leftW);
            const r = pad(
                truncateToWidth(this.outLines[this.outScroll + i] ?? "", rightW, ""),
                rightW
            );
            out.push(`${l} ${this.theme.fg("dim", "│")} ${r}`);
        }
        const counts = this.counts();
        out.push(this.theme.fg("dim", `  ${counts}`));
        return out;
    }

    private counts(): string {
        const j = [...this.reg.jobs.values()];
        const n = (s: string) => j.filter((x) => x.status === s).length;
        return `▶ ${n("running")} running · ✓ ${n("completed")} done · ✗ ${n("failed")} failed · ⊘ ${n("killed")} killed`;
    }

    invalidate(): void {
        this.list.invalidate();
    }

    // --- input --------------------------------------------------------------

    handleInput(data: string): void {
        if (this.focus === "output") return this.handleOutputKey(data);

        if (matchesKey(data, "escape")) {
            if (this.query) { this.query = ""; this.rebuild(); } else this.done();
            return;
        }
        if (data === "q" && !this.query) return this.done();
        if (matchesKey(data, "tab")) {
            this.filter = FILTERS[(FILTERS.indexOf(this.filter) + 1) % FILTERS.length]!;
            this.rebuild();
            return;
        }
        if (/^[1-5]$/.test(data)) {
            this.filter = FILTERS[Number(data) - 1]!;
            this.rebuild();
            return;
        }
        if (data === "x") {
            const j = this.selected();
            if (j && j.status === "running") {
                terminateJobSilently(this.reg, j);
                renderSidebar(this.reg, this.ctx);
            }
            this.rebuild();
            return;
        }
        if (data === "c") {
            const j = this.selected();
            if (j) void this.copy(j.command);
            return;
        }
        if (data === "d") {
            const j = this.selected();
            if (j) { forget(this.reg, j); renderSidebar(this.reg, this.ctx); }
            this.rebuild();
            return;
        }
        if (matchesKey(data, "enter")) {
            this.focus = "output";
            this.outFollow = true;
            this.updateOutput();
            return;
        }
        if (matchesKey(data, "backspace") || data === "\x7f") {
            this.query = this.query.slice(0, -1);
            this.rebuild();
            return;
        }
        // Arrows drive the list; any other printable char is a search query.
        if (/^\x1b\[[0-9;]*[A-C]$/.test(data)) {
            this.list.handleInput(data);
            return;
        }
        if (data.length === 1 && data >= " ") {
            this.query += data;
            this.rebuild();
        }
    }

    private handleOutputKey(data: string): void {
        if (matchesKey(data, "escape") || matchesKey(data, "enter")) { this.focus = "list"; return; }
        if (matchesKey(data, "up") || data === "k") { this.outScroll = Math.max(0, this.outScroll - 1); this.outFollow = false; return; }
        if (matchesKey(data, "down") || data === "j") { this.outScroll = Math.min(this.maxScroll(), this.outScroll + 1); this.outFollow = false; return; }
        if (matchesKey(data, "pageUp")) { this.outScroll = Math.max(0, this.outScroll - BODY_ROWS); this.outFollow = false; return; }
        if (matchesKey(data, "pageDown")) { this.outScroll = Math.min(this.maxScroll(), this.outScroll + BODY_ROWS); this.outFollow = false; return; }
    }

    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
        if (event.y < HEADER_ROWS) return undefined;
        const leftW = this.leftWidth(this.lastWidth);
        if (event.x < leftW) {
            const res = this.list.handleMouse({
                ...event,
                y: event.y - HEADER_ROWS,
                width: leftW,
                height: BODY_ROWS,
            });
            if (res?.handled) { this.updateOutput(); this.requestRender(); }
            return res;
        }
        if (event.x > leftW) {
            if (event.type === "wheel" && event.wheelDelta) {
                this.outScroll = Math.max(
                    0,
                    Math.min(this.maxScroll(), this.outScroll + event.wheelDelta)
                );
                this.outFollow = false;
                return { handled: true, render: true };
            }
            return { handled: true, render: true };
        }
        return undefined;
    }

    private async copy(text: string): Promise<void> {
        try {
            const clip = getNativeClipboard();
            if (clip?.setText) {
                await clip.setText(text);
                this.ctx.ui.notify("Copied command", "info");
                return;
            }
        } catch {
            /* fall through to showing it */
        }
        this.ctx.ui.notify(text, "info");
    }
}

/**
 * Task Monitor — the two-pane background-task modal, dressed like pi's /resume.
 *
 *   ───────────────────────────────────────────────────────────────   DynamicBorder(accent)
 *     Task Monitor                              ▶ 2 running · ✗ 1 failed · ✓ 3 done
 *     ↑↓ move · ⇥ filter · ⏎ output · x kill · c copy · d remove · esc close
 *     Search: ▏
 *    ▌▶ cargo build   │  ▶ cargo build --release   running  2m41s
 *                     │  $ cargo build --release
 *   ───────────────────────────────────────────────────────────────   DynamicBorder(accent)
 *
 * Left pane: a filterable task list. Right pane: the selected task's live log
 * tail. Reuses pi's own chrome — `DynamicBorder`, the `Theme` bg slots
 * (`selectedBg` row, `customMessageBg` output pane) and `getSelectListTheme`
 * conventions — so it matches /resume. Terminal-only; the caller falls back to
 * `openBgListPanel()` elsewhere.
 */

import { SelectList, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
    Component,
    SelectItem,
    SelectListTheme,
    TuiMouseEvent,
    TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
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
const BODY_ROWS = 22;
/** Lines above the body: border + header + hint + search. Mouse y is offset by this. */
const HEADER_ROWS = 4;

/** The runtime theme is pi's full Theme; patty only types `fg`. */
interface MonitorTheme extends StripTheme {
    bg?(slot: string, text: string): string;
    bold?(text: string): string;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, "");

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
                theme as unknown as MonitorTheme,
                () => (tui as { requestRender(): void }).requestRender(),
                done,
                initial
            ),
        { overlay: true, overlayOptions: { anchor: "center", width: "96%", maxHeight: "92%" } }
    );
}

export class TaskMonitor implements Component {
    private readonly reg: BackgroundRegistry;
    private readonly ctx: UiContext;
    private readonly theme: MonitorTheme;
    private readonly requestRender: () => void;
    private readonly done: (r?: void) => void;
    private readonly listTheme: SelectListTheme;
    private readonly border: DynamicBorder;

    private filter: TaskFilter;
    private query = "";
    private focus: "list" | "output" = "list";
    private outLines: string[] = [];
    private outScroll = 0;
    private outFollow = true;
    private lastWidth = 80;
    private list: SelectList;

    constructor(
        reg: BackgroundRegistry,
        ctx: UiContext,
        theme: MonitorTheme,
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
            // SelectList hardcodes the "→ " marker and wraps the WHOLE selected
            // item in selectedText; we give it the background so the row matches
            // pi's /resume, then re-paint it full-width in render().
            selectedPrefix: () => "→ ",
            selectedText: (t) => this.bg("selectedBg", this.theme.fg("accent", t)),
            description: (t) => this.theme.fg("muted", t),
            scrollInfo: (t) => this.theme.fg("muted", t),
            noMatch: (t) => this.theme.fg("muted", t),
        };
        this.border = new DynamicBorder((s) => this.theme.fg("accent", s));
        this.list = this.buildList();
        this.updateOutput();
    }

    // --- theme helpers ------------------------------------------------------

    private bg(slot: string, text: string): string {
        return this.theme.bg ? this.theme.bg(slot, text) : text;
    }

    private bold(text: string): string {
        return this.theme.bold ? this.theme.bold(text) : text;
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
            this.outLines = [this.theme.fg("muted", "  select a task")];
            return;
        }
        const tail = readLogTail(job, OUTPUT_PREVIEW_CHARS).replace(/\r/g, "");
        this.outLines = [
            `${icon(job)} ${jobLabel(job)}  ·  ${job.status}  ·  ${time(job)}  ·  ${dur(job)}`,
            `$ ${job.command}`,
            "─".repeat(40),
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

    private counts(): string {
        const j = [...this.reg.jobs.values()];
        const n = (s: string) => j.filter((x) => x.status === s).length;
        const parts: string[] = [];
        if (n("running")) parts.push(this.theme.fg("accent", `▶ ${n("running")} running`));
        if (n("completed")) parts.push(this.theme.fg("success", `✓ ${n("completed")} done`));
        if (n("failed")) parts.push(this.theme.fg("error", `✗ ${n("failed")} failed`));
        if (n("killed")) parts.push(this.theme.fg("muted", `⊘ ${n("killed")} killed`));
        return parts.join(this.theme.fg("muted", " · "));
    }

    render(width: number): string[] {
        this.lastWidth = width;
        const leftW = this.leftWidth(width);
        const rightW = Math.max(20, width - leftW - 3);

        const lines: string[] = [];
        lines.push(...this.border.render(width));

        const left = "  " + this.bold(this.theme.fg("accent", "Task Monitor"));
        const right = this.counts() + "  ";
        const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
        lines.push(left + " ".repeat(gap) + right);

        lines.push(this.theme.fg("muted",
            "  ↑↓ move · ⇥ filter · type to search · x kill · c copy · d remove · ⏎ focus output · esc close"));

        const tabs = FILTERS.map((f) =>
            f === this.filter ? this.theme.fg("accent", `[${f}]`) : this.theme.fg("muted", ` ${f} `)
        ).join("");
        lines.push("  " + this.theme.fg("muted", "Search: ") + this.theme.fg("accent", this.query) +
            (this.focus === "list" ? "▏" : "") + "   " + tabs);

        const listLines = this.list.render(leftW);
        for (let i = 0; i < BODY_ROWS; i++) {
            const raw = listLines[i] ?? "";
            const selected = strip(raw).trimStart().startsWith("→");
            const l = selected
                ? this.bg("selectedBg", this.theme.fg("accent", pad(truncateToWidth(strip(raw).trimStart(), leftW, ""), leftW)))
                : pad(truncateToWidth(raw, leftW, ""), leftW);
            const r = this.bg(
                "customMessageBg",
                pad(truncateToWidth(this.outLines[this.outScroll + i] ?? "", rightW, ""), rightW)
            );
            lines.push(`${l}${this.theme.fg("borderMuted", "│")}${r}`);
        }

        lines.push(...this.border.render(width));
        return lines;
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
        if (event.type === "wheel" && event.wheelDelta) {
            this.outScroll = Math.max(
                0,
                Math.min(this.maxScroll(), this.outScroll + event.wheelDelta)
            );
            this.outFollow = false;
            return { handled: true, render: true };
        }
        return undefined;
    }

    private async copy(text: string): Promise<void> {
        try {
            const { getNativeClipboard } = await import("@earendil-works/pi-tui");
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

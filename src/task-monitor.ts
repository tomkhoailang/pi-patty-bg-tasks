/**
 * Task Monitor — the two-pane background-task modal, dressed like pi's /resume.
 *
 *   ╭──────────────────────────────────────────────────────────────╮
 *   │  Task Monitor                    ▶ 2 running · ✗ 1 failed      │
 *   │  ↑↓ move · ⇥ filter · ⏎ output · x kill · c copy · esc close   │
 *   │  Search: ▏                                                   │
 *   │ → ▶ cargo build   ┃  ▶ cargo build --release   running 2m41s │
 *   ╰──────────────────────────────────────────────────────────────╯
 *
 * Left pane: a filterable task list (live). Right pane: the selected task's
 * header is PINNED (icon/name/status/time/command) and only the log tail
 * scrolls. Reuses pi's `Theme` bg slots (`selectedBg` row, `customMessageBg`
 * output pane) and `SelectListTheme` conventions, plus a rounded border in
 * `borderAccent`. Polls once a second while open, doing the cheapest check
 * first. Terminal-only; the caller falls back to `openBgListPanel()` elsewhere.
 */

import { statSync } from "node:fs";
import { SelectList, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
    Component,
    KeyId,
    SelectItem,
    SelectListTheme,
    TuiMouseEvent,
    TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import { OUTPUT_PREVIEW_CHARS, PREVIEW_CHARS } from "./types.ts";
import type { Job, StripTheme, UiContext } from "./types.ts";
import { elapsedMs, formatDuration, jobLabel } from "./format.ts";
import { readLogTail, renderSidebar } from "./registry.ts";
import { terminateJobSilently } from "./lifecycle.ts";
import { openBgListPanel } from "./ui.ts";

const FILTERS = ["all", "running", "completed", "failed", "killed"] as const;
export type TaskFilter = (typeof FILTERS)[number];

/** Rows in the body (list + output), and the SelectList window. */
const BODY_ROWS = 22;
/** Right-pane lines above the scrolling log: 2 header lines + 1 rule. */
const OUT_HEADER_LINES = 3;
const LOG_ROWS = BODY_ROWS - OUT_HEADER_LINES;
/** Inner-content lines before the body: title + action bar + blank + search + blank. */
const INNER_HEADER = 5;
/** Live poll cadence (ms). */
const POLL_MS = 1000;

/** The runtime theme is pi's full Theme; patty only types `fg`. */
interface MonitorTheme extends StripTheme {
    bg?(slot: string, text: string): string;
    bold?(text: string): string;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, "");

const time = (job: Job): string =>
    new Date(job.startTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Run duration — live while running, frozen at `endedAt` once terminal. */
const dur = (job: Job): string => formatDuration(elapsedMs(job));

const pad = (s: string, width: number): string =>
    s + " ".repeat(Math.max(0, width - visibleWidth(s)));

/** matchesKey over several spellings ("return"/"enter", "pageUp"/"pageup"). */
const anyKey = (data: string, ...ids: KeyId[]): boolean => ids.some((id) => matchesKey(data, id));

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

    private filter: TaskFilter;
    private query = "";
    private focus: "list" | "output" = "list";
    private outHeader: string[] = [];
    private outLines: string[] = [];
    private outScroll = 0;
    private outFollow = true;
    private lastWidth = 80;
    private list: SelectList;
    /** Clickable footer action buttons (inner-x ranges, recomputed each render). */
    private actionRanges: { start: number; end: number; enabled: boolean; index: number; run: () => void }[] = [];
    private hoveredButton = -1;
    /** Clickable filter tabs (inner-x ranges). */
    private filterRanges: { start: number; end: number; filter: TaskFilter }[] = [];

    private ticker: ReturnType<typeof setInterval> | undefined;
    private lastSig = "";
    private lastSelectedId: string | undefined;
    private lastLogSize = -1;

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
        this.list = this.buildList();
        this.updateOutput(true);
        this.ticker = setInterval(() => this.tick(), POLL_MS);
        this.ticker.unref?.();
    }

    dispose(): void {
        this.clearTicker();
    }

    private clearTicker(): void {
        if (this.ticker) { clearInterval(this.ticker); this.ticker = undefined; }
    }

    private close(): void {
        this.clearTicker();
        this.done();
    }

    // --- theme helpers ------------------------------------------------------

    private bg(slot: string, text: string): string {
        return this.theme.bg ? this.theme.bg(slot, text) : text;
    }

    private bold(text: string): string {
        return this.theme.bold ? this.theme.bold(text) : text;
    }

    /** Status glyph, reusing pi's vocabulary ("✓" success / "✗" failure) with a
     *  plain "●" for live work — coloured, no decorative symbols. */
    private icon(job: Job): string {
        if (job.status === "running") {
            return this.theme.fg(job.stalled ? "warning" : "accent", "●");
        }
        if (job.status === "completed") return this.theme.fg("success", "✓");
        if (job.status === "failed") return this.theme.fg("error", "✗");
        return this.theme.fg("muted", "·"); // killed
    }

    // --- data ---------------------------------------------------------------

    /** Every known task: running (reg.jobs) + terminal (reg.recentTerminal),
     *  de-duplicated by id. `forget()` moves finished jobs to recentTerminal. */
    private allJobs(): Job[] {
        const seen = new Set<string>();
        const out: Job[] = [];
        for (const j of [...this.reg.jobs.values(), ...(this.reg.recentTerminal ?? [])]) {
            if (seen.has(j.id)) continue;
            seen.add(j.id);
            out.push(j);
        }
        return out;
    }

    private jobs(): Job[] {
        const q = this.query.toLowerCase();
        return this.allJobs()
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
            label: `${this.icon(j)} ${jobLabel(j)}`,
            description: `${j.command.slice(0, PREVIEW_CHARS.taskList)} · ${time(j)} · ${dur(j)}`,
        }));
        const list = new SelectList(items, BODY_ROWS, this.listTheme, {
            minPrimaryColumnWidth: 12,
            maxPrimaryColumnWidth: 30,
        });
        list.onSelectionChange = () => { this.updateOutput(); this.requestRender(); };
        list.invalidate();
        return list;
    }

    private selected(): Job | undefined {
        const id = this.list.getSelectedItem()?.value;
        return id ? this.allJobs().find((j) => j.id === id) : undefined;
    }

    /** Rebuild the list (filter/search/action) preserving the selected id. */
    private rebuild(): void {
        const prev = this.list.getSelectedItem()?.value;
        const idx = this.jobs().findIndex((j) => j.id === prev);
        this.list = this.buildList();
        if (idx > 0) this.list.setSelectedIndex(idx);
        this.updateOutput(true);
        this.requestRender();
    }

    private remove(job: Job): void {
        this.reg.jobs.delete(job.id);
        const recent = this.reg.recentTerminal;
        if (recent) {
            const i = recent.findIndex((j) => j.id === job.id);
            if (i >= 0) recent.splice(i, 1);
        }
    }

    // --- polling ------------------------------------------------------------

    private tick(): void {
        const all = this.allJobs();
        const sig = all.map((j) => `${j.id}:${j.status}:${j.stalled ? 1 : 0}`).join("|");
        let changed = false;

        if (sig !== this.lastSig) {
            this.lastSig = sig;
            this.rebuildListOnly();
            changed = true;
        }

        const job = this.selected();
        const id = job?.id;
        let size = -1;
        if (job) {
            try { size = statSync(job.logPath).size; } catch { /* not created yet */ }
        }
        if (id !== this.lastSelectedId || size !== this.lastLogSize) {
            const selectionChanged = id !== this.lastSelectedId;
            this.lastSelectedId = id;
            this.lastLogSize = size;
            this.updateOutput(selectionChanged);
            changed = true;
        }

        if (changed) this.requestRender();
    }

    /** Rebuild the SelectList without touching the output pane (poll path). */
    private rebuildListOnly(): void {
        const prev = this.list.getSelectedItem()?.value;
        const idx = this.jobs().findIndex((j) => j.id === prev);
        this.list = this.buildList();
        if (idx > 0) this.list.setSelectedIndex(idx);
    }

    /** Refresh the pinned header + log tail. `resetScroll` follows the end. */
    private updateOutput(resetScroll = false): void {
        const job = this.selected();
        if (!job) {
            this.outHeader = [];
            this.outLines = [this.theme.fg("muted", "  select a task")];
            return;
        }
        this.outHeader = [
            `${this.icon(job)} ${jobLabel(job)}  ·  ${job.status}  ·  ${time(job)}  ·  ${dur(job)}`,
            `$ ${job.command}`,
        ];
        const tail = readLogTail(job, OUTPUT_PREVIEW_CHARS).replace(/\r/g, "");
        this.outLines = tail.length ? tail.split("\n") : [this.theme.fg("muted", "  (no output yet)")];
        if (resetScroll || this.outFollow) {
            this.outScroll = Math.max(0, this.outLines.length - LOG_ROWS);
        }
    }

    private maxScroll(): number {
        return Math.max(0, this.outLines.length - LOG_ROWS);
    }

    /** Scrollbar cell for a viewport row: `┃` thumb over a `│` track. */
    private scrollbarChar(row: number): string {
        const total = this.outLines.length;
        const view = LOG_ROWS;
        const thumbSize = Math.max(1, Math.round((view * view) / total));
        const maxTop = Math.max(0, view - thumbSize);
        const thumbTop = this.maxScroll() > 0
            ? Math.round((this.outScroll / this.maxScroll()) * maxTop)
            : 0;
        const isThumb = row >= thumbTop && row < thumbTop + thumbSize;
        return isThumb
            ? this.theme.fg("scrollbarThumb", "┃")
            : this.theme.fg("scrollbarTrack", "│");
    }

    // --- render -------------------------------------------------------------

    private leftWidth(width: number): number {
        return Math.max(30, Math.min(56, Math.round(width * 0.4)));
    }

    private counts(): string {
        const j = this.allJobs();
        const n = (s: string) => j.filter((x) => x.status === s).length;
        const parts: string[] = [];
        if (n("running")) parts.push(this.theme.fg("accent", `● ${n("running")} running`));
        if (n("completed")) parts.push(this.theme.fg("success", `✓ ${n("completed")} done`));
        if (n("failed")) parts.push(this.theme.fg("error", `✗ ${n("failed")} failed`));
        if (n("killed")) parts.push(this.theme.fg("muted", `· ${n("killed")} killed`));
        return parts.join(this.theme.fg("muted", " · "));
    }

    render(width: number): string[] {
        this.lastWidth = width;
        const innerW = Math.max(24, width - 2);
        const leftW = this.leftWidth(innerW);
        const rightW = Math.max(16, innerW - leftW - 1);

        const frame = (s: string) => this.theme.fg("borderAccent", s);
        const bar = (s: string) => this.theme.fg("borderMuted", s);
        const inner: string[] = [];

        const title = "  " + this.bold(this.theme.fg("accent", "Task Monitor"));
        const counts = this.counts() + "  ";
        const gap = Math.max(1, innerW - visibleWidth(title) - visibleWidth(counts));
        inner.push(title + " ".repeat(gap) + counts);

        // Clickable action buttons (pills) + key hints. Ranges are inner-x offsets.
        const selJob = this.selected();
        const acts: { key: string; label: string; enabled: boolean; run: () => void }[] = [
            { key: "x", label: "kill", enabled: selJob?.status === "running", run: () => this.actKill() },
            { key: "c", label: "copy", enabled: !!selJob, run: () => this.actCopy() },
            { key: "d", label: "remove", enabled: !!selJob, run: () => this.actRemove() },
            { key: "⏎", label: "output", enabled: !!selJob, run: () => this.actOutput() },
            { key: "esc", label: "close", enabled: true, run: () => this.actClose() },
        ];
        let barLine = "  ";
        const ranges: typeof this.actionRanges = [];
        for (let i = 0; i < acts.length; i++) {
            const a = acts[i]!;
            const text = ` ${a.key} ${a.label} `;
            const styled = !a.enabled
                ? this.bg("selectedBg", this.theme.fg("muted", text))
                : this.hoveredButton === i
                    ? this.bg("toolPendingBg", this.theme.fg("accent", this.bold(text)))
                    : this.bg("selectedBg", this.theme.fg("text", text));
            const start = visibleWidth(barLine);
            barLine += styled + " ";
            ranges.push({ start, end: start + visibleWidth(text), enabled: a.enabled, index: i, run: a.run });
        }
        this.actionRanges = ranges;
        inner.push(barLine + this.theme.fg("dim", "↑↓ · ⇥ filter · type to search"));
        inner.push("");
        const tabsLine = "  " + this.theme.fg("muted", "Search: ") + this.theme.fg("accent", this.query) +
            (this.focus === "list" ? "▏" : "") + "   ";
        let searchLine = tabsLine;
        const franges: typeof this.filterRanges = [];
        for (const f of FILTERS) {
            const label = f === this.filter ? `[${f}]` : ` ${f} `;
            const styled = f === this.filter ? this.theme.fg("accent", label) : this.theme.fg("muted", label);
            const start = visibleWidth(searchLine);
            searchLine += styled;
            franges.push({ start, end: start + visibleWidth(label), filter: f });
        }
        this.filterRanges = franges;
        inner.push(searchLine);
        inner.push("");

        // Right pane: pinned header + rule, then the scrolling log (with scrollbar).
        const right: string[] = this.outHeader.length
            ? [...this.outHeader, bar("─".repeat(Math.max(1, rightW - 2))),
               ...this.outLines.slice(this.outScroll, this.outScroll + LOG_ROWS)]
            : [this.outLines[0] ?? ""];
        const sbWidth = this.outLines.length > LOG_ROWS ? 1 : 0;
        const MARGIN = 1; // left padding inside the output pane

        const listLines = this.list.render(leftW);
        for (let i = 0; i < BODY_ROWS; i++) {
            const raw = listLines[i] ?? "";
            const selected = strip(raw).trimStart().startsWith("→");
            const l = selected
                ? this.bg("selectedBg", this.theme.fg("accent", pad(truncateToWidth(strip(raw).trimStart(), leftW, ""), leftW)))
                : pad(truncateToWidth(raw, leftW, ""), leftW);
            let cell: string;
            if (sbWidth && i >= OUT_HEADER_LINES) {
                const w = rightW - MARGIN - 1;
                cell = " ".repeat(MARGIN) + pad(truncateToWidth(right[i] ?? "", w, ""), w)
                    + this.scrollbarChar(i - OUT_HEADER_LINES);
            } else {
                const w = rightW - MARGIN;
                cell = " ".repeat(MARGIN) + pad(truncateToWidth(right[i] ?? "", w, ""), w);
            }
            inner.push(`${l}${bar("│")}${this.bg("customMessageBg", cell)}`);
        }

        return [
            frame("╭" + "─".repeat(innerW) + "╮"),
            ...inner.map((line) => frame("│") + pad(truncateToWidth(line, innerW, ""), innerW) + frame("│")),
            frame("╰" + "─".repeat(innerW) + "╯"),
        ];
    }

    invalidate(): void {
        this.list.invalidate();
    }

    // --- input --------------------------------------------------------------

    handleInput(data: string): void {
        if (this.focus === "output") return this.handleOutputKey(data);

        if (matchesKey(data, "escape")) return this.close();
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
        if (data === "x") return void this.actKill();
        if (data === "c") return void this.actCopy();
        if (data === "d") return void this.actRemove();
        if (anyKey(data, "return", "enter")) return void this.actOutput();
        if (matchesKey(data, "backspace") || data === "\x7f") {
            this.query = this.query.slice(0, -1);
            this.rebuild();
            return;
        }
        if (anyKey(data, "up", "down")) {
            this.list.handleInput(data);
            return;
        }
        // Scroll the selected task's output without focusing the pane.
        if (anyKey(data, "home", "end", "pageUp", "pageDown")) {
            this.handleOutputKey(data);
            this.requestRender();
            return;
        }
        if (data.length === 1 && data >= " ") {
            this.query += data;
            this.rebuild();
        }
    }

    private actKill(): void {
        const j = this.selected();
        if (j && j.status === "running") {
            terminateJobSilently(this.reg, j);
            renderSidebar(this.reg, this.ctx);
        }
        this.rebuild();
    }

    private actCopy(): void {
        const j = this.selected();
        if (j) void this.copy(j.command);
    }

    private actRemove(): void {
        const j = this.selected();
        if (j) { this.remove(j); renderSidebar(this.reg, this.ctx); }
        this.rebuild();
    }

    private actOutput(): void {
        this.focus = "output";
        this.outFollow = true;
        this.updateOutput();
        this.requestRender();
    }

    private actClose(): void {
        this.close();
    }

    private handleOutputKey(data: string): void {
        if (matchesKey(data, "escape")) return this.close();
        if (anyKey(data, "return", "enter")) { this.focus = "list"; return; }
        if (anyKey(data, "up") || data === "k") { this.outScroll = Math.max(0, this.outScroll - 1); this.outFollow = false; return; }
        if (anyKey(data, "down") || data === "j") { this.outScroll = Math.min(this.maxScroll(), this.outScroll + 1); this.outFollow = false; return; }
        if (anyKey(data, "pageUp")) { this.outScroll = Math.max(0, this.outScroll - LOG_ROWS); this.outFollow = false; return; }
        if (anyKey(data, "pageDown")) { this.outScroll = Math.min(this.maxScroll(), this.outScroll + LOG_ROWS); this.outFollow = false; return; }
        if (anyKey(data, "home")) { this.outScroll = 0; this.outFollow = false; return; }
        if (anyKey(data, "end")) { this.outScroll = this.maxScroll(); this.outFollow = true; return; }
    }

    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
        const innerX = event.x - 1; // inside the frame
        const innerY = event.y - 1;
        if (innerX < 0) return undefined;
        // Footer action buttons sit on inner line 1.
        if (innerY === 1) {
            const hit = this.actionRanges.find((r) => innerX >= r.start && innerX < r.end);
            const idx = hit ? hit.index : -1;
            const hoverChanged = idx !== this.hoveredButton;
            this.hoveredButton = idx;
            if ((event.type === "click" || event.type === "press") && hit?.enabled) {
                hit.run();
                return { handled: true, render: true };
            }
            return { handled: true, render: hoverChanged };
        }
        // Moving off the bar clears the hover highlight.
        if (event.type === "move" && this.hoveredButton !== -1) {
            this.hoveredButton = -1;
            return { handled: true, render: true };
        }
        // Filter tabs sit on inner line 4 (title, action bar, blank, search).
        if (innerY === 4) {
            if (event.type === "click" || event.type === "press") {
                const hit = this.filterRanges.find((r) => innerX >= r.start && innerX < r.end);
                if (hit) { this.filter = hit.filter; this.rebuild(); return { handled: true, render: true }; }
            }
            return { handled: true };
        }
        // Body rows start after the inner header (title + action bar + search).
        if (innerY < INNER_HEADER) return undefined;
        const row = innerY - INNER_HEADER;
        const innerW = Math.max(24, this.lastWidth - 2);
        const leftW = this.leftWidth(innerW);
        // Draggable scrollbar: the last column of the output pane.
        if (this.outLines.length > LOG_ROWS && innerX === innerW - 1 && row >= OUT_HEADER_LINES) {
            if (event.type === "press" || event.type === "drag" || event.type === "click") {
                const r = row - OUT_HEADER_LINES;
                const frac = LOG_ROWS > 1 ? r / (LOG_ROWS - 1) : 0;
                this.outScroll = Math.max(0, Math.min(this.maxScroll(), Math.round(frac * this.maxScroll())));
                this.outFollow = false;
                return { handled: true, capture: event.type === "press", render: true };
            }
            return { handled: true };
        }
        if (innerX < leftW) {
            const res = this.list.handleMouse({
                ...event,
                x: innerX,
                y: row,
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
        // Right-pane primary-button drags fall through, so pi's transcript
        // selection still works for copying a chunk of output.
        return undefined;
    }

    private async copy(text: string): Promise<void> {
        try {
            // pi's helper handles Wayland/X11, WSL (PowerShell), and OSC 52 —
            // getNativeClipboard().setText is a no-op on Linux.
            await copyToClipboard(text);
            this.ctx.ui.notify("Copied command", "info");
        } catch {
            this.ctx.ui.notify(text, "info");
        }
    }
}

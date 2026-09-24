/**
 * The job registry — the single point of truth for every running or
 * recently-terminal background job. All CRUD operations live here.
 *
 * On top of the data store, this module renders the in-session sidebar
 * pill bar (`renderSidebar`) and aggregates stats (`getStats`).
 */

import { statSync, unlinkSync } from "node:fs";
import { elapsedMs, formatDuration, jobLabel } from "./format.ts";
import {
    MAX_CONCURRENT_JOBS,
    PREVIEW_CHARS,
    RECENT_TERMINAL_KEEP,
    type Job,
    type JobKind,
    type StripRow,
    type StripState,
    type UiContext,
} from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import { readBoundedTail, readLastLine } from "./output.ts";
import { DETAIL_TAIL_LINES, STRIP_VISIBLE_LINES, createStripWidget, openStripPanel } from "./strip.ts";

/** Upper bound on the completed/killed pool the strip may draw from. Only
 *  reached when expanded — it exists so a long session cannot accumulate an
 *  unbounded row list. */
const STRIP_POOL_MAX = 20;
/** Bytes of log tail read for the inline detail block. */
const DETAIL_TAIL_CHARS = 400;

/**
 * Detail shown under the expanded row: a meta line plus recent output. Bounded
 * so the block cannot grow and push the rest of the strip around, and the job
 * name leads the meta line so the block is attributable even if it is ever drawn
 * at full width rather than under its own row.
 *
 * Never throws: this runs inside render(), so a vanishing log file (job killed,
 * log swept) must degrade to a note rather than take the whole strip down.
 */
function stripDetail(job: Job): string[] {
    const exit = job.exitCode !== undefined ? ` · exit ${job.exitCode}` : "";
    const meta = `${jobLabel(job)} · ${job.status}${exit} · ${formatDuration(elapsedMs(job))}`;
    try {
        const tail = readLogTail(job, DETAIL_TAIL_CHARS)
            .split("\n")
            .map((line) => line.trimEnd())
            .filter((line) => line.length > 0);
        return [meta, ...tail.slice(-DETAIL_TAIL_LINES)];
    } catch {
        return [meta, "(log unavailable)"];
    }
}

/** Ask the widget to repaint. A stale handle means the next install recreates it. */
function requestStripRender(reg: BackgroundRegistry): void {
    try {
        reg.stripTui?.requestRender();
    } catch {
        reg.stripTui = undefined;
        reg.stripInstalled = false;
    }
}

// --- ID generation -------------------------------------------------------

export function nextJobId(reg: BackgroundRegistry): string {
    return `job-${process.pid}-${++reg.counter}`;
}

/** Dedicated log directory. Keeping logs in their own dir (not loose in /tmp)
 *  keeps the stale-log sweep bounded — it lists only our files. */
export const LOG_DIR = "/tmp/pi-bg";

export function logPathFor(jobId: string): string {
    return `${LOG_DIR}/${jobId}.log`;
}

/** Sibling stderr-capture path for a monitor's split output. Keeps the
 *  `.log`/`.err` naming convention in one place. */
export function errPathFor(jobId: string): string {
    return `${LOG_DIR}/${jobId}.err`;
}

/**
 * Build a fresh running Job. Centralizes the Job shape so the new `kind`/`stop`
 * fields (and any future additions) don't drift across the bash/bash_bg/
 * agent_bg/monitor construction sites.
 */
export function createRunningJob(args: {
    id: string;
    command: string;
    pid: number;
    logPath: string;
    toolCallId: string;
    name?: string;
    kind?: JobKind;
    isBackgrounded?: boolean;
}): Job {
    return {
        id: args.id,
        name: args.name,
        command: args.command,
        pid: args.pid,
        startTime: Date.now(),
        status: "running",
        logPath: args.logPath,
        toolCallId: args.toolCallId,
        isBackgrounded: args.isBackgrounded ?? true,
        kind: args.kind,
    };
}

// --- Registry mutations --------------------------------------------------

/** Record that a job has started (lifetime counter). */
export function markStarted(reg: BackgroundRegistry): void {
    reg.totalStarted++;
}

/** Add a brand-new running job and count it as started. */
export function add(reg: BackgroundRegistry, job: Job): Job {
    reg.jobs.set(job.id, job);
    markStarted(reg);
    return job;
}

/** True once the running-job count has reached the concurrency cap. Counts with
 *  a short-circuit so it stops at the cap instead of scanning the whole map. */
export function atConcurrencyLimit(reg: BackgroundRegistry): boolean {
    let n = 0;
    for (const job of reg.jobs.values()) {
        if (job.status === "running" && ++n >= MAX_CONCURRENT_JOBS) return true;
    }
    return false;
}

/**
 * Remove a terminal job from the live map and update lifetime counters.
 * Returns the removed job (or undefined if it wasn't in the map).
 */
export function forget(reg: BackgroundRegistry, job: Job): Job | undefined {
    if (!reg.jobs.delete(job.id)) return undefined;
    if (reg.pendingDecisionJobId === job.id) {
        reg.pendingDecisionJobId = undefined;
    }
    if (job.status === "completed") {
        reg.completedCount++;
        reg.totalDurationMs += terminalDurationMs(job);
    } else if (job.status === "failed") {
        reg.failedCount++;
        reg.totalDurationMs += terminalDurationMs(job);
    }
    reg.recentTerminal.push(job);
    if (reg.recentTerminal.length > RECENT_TERMINAL_KEEP) {
        reg.recentTerminal.shift();
    }
    return job;
}

/** Look up a job by ID. Falls back to prepending "job-" for the common
 *  LLM-stripping case, and to recent-terminal jobs for completed ones. */
export function findJob(reg: BackgroundRegistry, jobId: string): Job | undefined {
    return (
        reg.jobs.get(jobId) ??
        reg.jobs.get(`job-${jobId}`) ??
        reg.recentTerminal.find((j) => j.id === jobId || j.id === `job-${jobId}`)
    );
}

/** Purge all terminal jobs from in-memory state and delete their log files. */
export function cleanupTerminal(reg: BackgroundRegistry): {
    purged: number;
    bytesReclaimed: number;
} {
    let purged = 0;
    let bytes = 0;
    const deletedLogs = new Set<string>();
    const deleteOnce = (logPath: string): number => {
        if (deletedLogs.has(logPath)) return 0;
        deletedLogs.add(logPath);
        return deleteLogFile(logPath);
    };

    const idsToRemove: string[] = [];
    for (const [id, job] of reg.jobs.entries()) {
        if (job.status !== "running") {
            idsToRemove.push(id);
            bytes += deleteOnce(job.logPath);
            purged++;
        }
    }
    for (const id of idsToRemove) {
        reg.jobs.delete(id);
    }
    // recent-terminal 링도 종료된 잡이므로 로그 파일까지 함께 정리.
    for (const job of reg.recentTerminal) {
        bytes += deleteOnce(job.logPath);
        purged++;
    }
    reg.recentTerminal.length = 0;
    return { purged, bytesReclaimed: bytes };
}

function deleteLogFile(logPath: string): number {
    try {
        const { size } = statSync(logPath);
        unlinkSync(logPath);
        return size;
    } catch {
        return 0;
    }
}

// ─── Sidebar rendering ───────────────────────────────────────────────────

/**
 * Render the pill-bar status widget and aggregate status-bar text, and keep a
 * 1 Hz ticker running while any job is alive so the durations stay live (the
 * widget isn't redrawn on a timer otherwise). Re-renders only when the content
 * actually changes. Call after any state change that affects running jobs.
 */
/** Build the structured strip row for one job. */
function jobRow(job: Job, state: StripState): StripRow {
    return {
        kind: "job",
        job,
        state,
        name: jobLabel(job),
        detail: (readLastLine(job.logPath) || job.command).slice(0, PREVIEW_CHARS.progress),
        elapsed: formatDuration(elapsedMs(job)),
    };
}

/** Newest-finished first, using the stamped finish time when present. */
function byFinishDesc(a: Job, b: Job): number {
    return (b.endedAt ?? b.startTime) - (a.endedAt ?? a.startTime);
}

/**
 * Build the full ordered row list. **No slicing and no toggle here** — the
 * visible budget depends on the terminal width (it is expressed in lines, not
 * items), and width is only known inside the widget component. The strip's
 * render() and hit-test both apply that budget through one shared function so
 * they cannot disagree about what is visible.
 *
 * Order is canonical: running, then the pinned buckets, then quiet history.
 */
function buildStripRows(reg: BackgroundRegistry): StripRow[] {
    const jobs = Array.from(reg.jobs.values());

    const live = jobs.filter((job) => job.status === "running");

    // A stalled job is blocked on a human and will never produce another byte,
    // so it is an outstanding decision — not ordinary in-flight work. It gets
    // the same protection as failures and is never displaced by the limit.
    const stalled = live.filter((job) => job.stalled).map((job) => jobRow(job, "stalled"));
    const running = live.filter((job) => !job.stalled).map((job) => jobRow(job, "running"));

    const failed = jobs
        .filter((job) => job.status === "failed")
        .sort(byFinishDesc)
        .map((job) => jobRow(job, "failed"));

    const quiet = jobs
        .filter((job) => job.status === "completed" || job.status === "killed")
        .sort(byFinishDesc)
        .slice(0, STRIP_POOL_MAX)
        .map((job) => jobRow(job, job.status as StripState));

    return [...running, ...stalled, ...failed, ...quiet];
}

/**
 * Render the pill-bar widget and status-bar text, and keep a 1 Hz ticker
 * running while any job is alive so durations stay live.
 *
 * The widget uses setWidget's COMPONENT overload rather than `string[]`: the
 * string form is capped at 10 lines and cannot receive mouse events. Pi keeps
 * the component instance, so it is installed once and later updates go through
 * `requestRender()` — the component reads live state at render time.
 * Non-TUI modes (and any context that does not report `mode: "tui"`) keep the
 * original string path, which is what Pi's own examples guard on.
 */
export function renderSidebar(reg: BackgroundRegistry, ctx: UiContext): void {
    const rows = buildStripRows(reg);
    const jobs = Array.from(reg.jobs.values());
    /** Running AND stalled — drives the ticker so elapsed times keep counting. */
    const liveCount = jobs.filter((job) => job.status === "running").length;
    /** Genuinely healthy work. A stalled job is its own segment, so these two
     *  must not overlap or the same job is counted twice in the status line. */
    const runningCount = jobs.filter((job) => job.status === "running" && !job.stalled).length;
    const stalledCount = jobs.filter((job) => job.status === "running" && job.stalled).length;
    const failedCount = jobs.filter((job) => job.status === "failed").length;
    const isTui = ctx.mode === "tui";

    if (rows.length === 0) {
        stopSidebarTicker(reg);
        if (reg.stripInstalled || reg.lastSidebarContent !== undefined || reg.lastStatusText !== undefined) {
            reg.stripInstalled = false;
            reg.stripTui = undefined;
            reg.stripExpandedJob = undefined;
            reg.lastSidebarContent = undefined;
            reg.lastStatusText = undefined;
            ctx.ui.setWidget("background-jobs", undefined);
            ctx.ui.setStatus("background-jobs", undefined);
        }
        return;
    }

    if (isTui) {
        if (!reg.stripInstalled) {
            reg.stripInstalled = true;
            ctx.ui.setWidget(
                "background-jobs",
                createStripWidget(
                    () => buildStripRows(reg),
                    ctx.ui.theme,
                    {
                        select: (job) => { void openStripPanel(job, ctx); },
                        expand: (jobId) => {
                            reg.stripExpandedJob = jobId;
                            requestStripRender(reg);
                        },
                        toggleList: () => {
                            reg.stripExpanded = !reg.stripExpanded;
                            requestStripRender(reg);
                        },
                        kill: (job) => {
                            reg.killJob?.(job);
                            reg.stripExpandedJob = undefined;
                            renderSidebar(reg, ctx);
                        },
                        expandedJobId: () => reg.stripExpandedJob,
                        listExpanded: () => reg.stripExpanded,
                        detail: stripDetail,
                    },
                    (handler) => { reg.stripKeyHandler = handler; },
                    (handle) => { reg.stripTui = handle; }
                )
            );
        }
    } else {
        // No columns outside the TUI, so the line budget has nothing to
        // multiply by — show that many rows flat.
        const shown = rows
            .slice(0, STRIP_VISIBLE_LINES)
            .map((row) =>
                row.kind === "toggle" ? row.text : `▶ ${row.name}: ${row.detail} (${row.elapsed})`
            );
        const key = shown.join("\n");
        if (key !== reg.lastSidebarContent) {
            reg.lastSidebarContent = key;
            ctx.ui.setWidget("background-jobs", shown);
        }
    }

    // Status line: semantic slots joined by a dim separator.
    const parts: string[] = [];
    if (runningCount > 0) parts.push(ctx.ui.theme.fg("accent", `▶ ${runningCount} running`));
    if (stalledCount > 0) parts.push(ctx.ui.theme.fg("warning", `⚠ ${stalledCount} stalled`));
    if (failedCount > 0) parts.push(ctx.ui.theme.fg("error", `✗ ${failedCount} failed`));
    if (reg.completedCount > 0) parts.push(ctx.ui.theme.fg("dim", `✓ ${reg.completedCount} done`));
    const statusText = parts.join(ctx.ui.theme.fg("dim", " · "));

    if (statusText !== reg.lastStatusText) {
        reg.lastStatusText = statusText;
        ctx.ui.setStatus("background-jobs", statusText);
    }

    if (liveCount > 0) {
        requestStripRender(reg);
        ensureSidebarTicker(reg, ctx);
    } else {
        // Only terminal rows left: nothing ticks, so no timer needed.
        stopSidebarTicker(reg);
    }
}

/** Start the live-duration ticker if not already running. */
function ensureSidebarTicker(reg: BackgroundRegistry, ctx: UiContext): void {
    if (reg.sidebarTimer) return;
    const t = setInterval(() => {
        try {
            renderSidebar(reg, ctx);
        } catch {
            // The captured ctx went stale (session reload/fork/switch) — stop
            // ticking rather than throw an uncaught exception in the interval.
            stopSidebarTicker(reg);
        }
    }, 1000);
    t.unref();
    reg.sidebarTimer = t;
}

/** Stop the live-duration ticker (no running jobs, or on shutdown). */
export function stopSidebarTicker(reg: BackgroundRegistry): void {
    if (reg.sidebarTimer) {
        clearInterval(reg.sidebarTimer);
        reg.sidebarTimer = undefined;
    }
}

// ─── 통계 ───────────────────────────────────────────────────────────────────────────────────

export interface JobStats {
    totalStarted: number;
    running: number;
    completed: number;
    failed: number;
    killed: number;
    recentTerminal: number;
    averageDurationMs: number;
    totalDurationMs: number;
}

export function getStats(reg: BackgroundRegistry): JobStats {
    let running = 0;
    let killed = 0;
    for (const job of reg.jobs.values()) {
        if (job.status === "running") running++;
        else if (job.status === "killed") killed++;
    }
    const terminalCount = reg.completedCount + reg.failedCount;
    return {
        totalStarted: reg.totalStarted,
        running,
        completed: reg.completedCount,
        failed: reg.failedCount,
        killed,
        recentTerminal: reg.recentTerminal.length,
        averageDurationMs:
            terminalCount > 0
                ? Math.round(reg.totalDurationMs / terminalCount)
                : 0,
        totalDurationMs: reg.totalDurationMs,
    };
}

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────────────────

function terminalDurationMs(job: Job): number {
    return elapsedMs(job);
}

// ─── 상태 헬퍼 (툴·단축키에서 사용) ───────────────────────────────────────────────────────

/** True when the job is currently in the running state. */
export function isRunning(job: Job): boolean {
    return job.status === "running";
}

/** Read only the tail of a job's log file — O(maxChars) even for large files. */
export function readLogTail(job: Job, maxChars: number): string {
    return readBoundedTail(job.logPath, maxChars);
}

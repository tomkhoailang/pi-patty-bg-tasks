/**
 * The job registry — the single point of truth for every running or
 * recently-terminal background job. All CRUD operations live here.
 *
 * On top of the data store, this module renders the in-session sidebar
 * pill bar (`renderSidebar`) and aggregates stats (`getStats`).
 */

import { statSync, unlinkSync } from "node:fs";
import { formatDuration, jobLabel } from "./format.ts";
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
import { STRIP_VISIBLE_LIMIT, createStripWidget, openStripPanel } from "./strip.ts";

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
        elapsed: formatDuration(Date.now() - job.startTime),
    };
}

/** Newest-finished first, using the stamped finish time when present. */
function byFinishDesc(a: Job, b: Job): number {
    return (b.endedAt ?? b.startTime) - (a.endedAt ?? a.startTime);
}

/**
 * Build the rows the strip renders, applying the attention policy:
 *
 *   - running jobs fill the visible budget first (STRIP_VISIBLE_LIMIT)
 *   - stalled jobs are pinned: blocked on a human, they will never progress,
 *     so the limit must not be able to hide them
 *   - failures ride BELOW the running rows and are never displaced by that
 *     limit — an unacknowledged failure is a decision still outstanding
 *   - completed / killed are expanded-only: you either just stopped it or it
 *     already succeeded, so neither earns space in the collapsed view
 *   - a toggle line appears only when something is actually hidden
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
        .slice(0, STRIP_VISIBLE_LIMIT)
        .map((job) => jobRow(job, "failed"));

    const quietPool = jobs
        .filter((job) => job.status === "completed" || job.status === "killed")
        .sort(byFinishDesc)
        .slice(0, STRIP_VISIBLE_LIMIT);

    const quiet = reg.stripExpanded
        ? quietPool.map((job) => jobRow(job, job.status as StripState))
        : [];

    const visibleRunning = reg.stripExpanded ? running : running.slice(0, STRIP_VISIBLE_LIMIT);
    const rows = [...visibleRunning, ...stalled, ...failed, ...quiet];

    // Count what expansion WOULD reveal, not merely what is hidden right now:
    // `quiet` is empty while collapsed, so comparing against rows.length alone
    // reported "nothing hidden" and left killed/completed jobs unreachable.
    const reachable = running.length + stalled.length + failed.length + quietPool.length;

    if (!reg.stripExpanded && reachable > rows.length) {
        rows.push({ kind: "toggle", text: `▾ +${reachable - rows.length} more` });
    } else if (reg.stripExpanded && reachable > STRIP_VISIBLE_LIMIT) {
        rows.push({ kind: "toggle", text: "▴ collapse" });
    }

    return rows;
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
    const runningCount = jobs.filter((job) => job.status === "running").length;
    const stalledCount = jobs.filter((job) => job.status === "running" && job.stalled).length;
    const failedCount = jobs.filter((job) => job.status === "failed").length;
    const isTui = ctx.mode === "tui";

    if (rows.length === 0) {
        stopSidebarTicker(reg);
        if (reg.stripInstalled || reg.lastSidebarContent !== undefined || reg.lastStatusText !== undefined) {
            reg.stripInstalled = false;
            reg.stripTui = undefined;
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
                    (job) => { void openStripPanel(job, ctx); },
                    () => {
                        reg.stripExpanded = !reg.stripExpanded;
                        try {
                            reg.stripTui?.requestRender();
                        } catch {
                            /* stale handle — the next install recreates it */
                        }
                    },
                    (handle) => { reg.stripTui = handle; }
                )
            );
        }
    } else {
        const key = rows
            .map((row) => (row.kind === "toggle" ? row.text : `${row.name}:${row.detail}:${row.elapsed}`))
            .join("\n");
        if (key !== reg.lastSidebarContent) {
            reg.lastSidebarContent = key;
            ctx.ui.setWidget(
                "background-jobs",
                rows.map((row) =>
                    row.kind === "toggle" ? row.text : `▶ ${row.name}: ${row.detail} (${row.elapsed})`
                )
            );
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

    if (runningCount > 0) {
        try {
            reg.stripTui?.requestRender();
        } catch {
            // TUI handle went stale (session reload/switch) — drop it so the
            // next pass reinstalls the widget.
            reg.stripTui = undefined;
            reg.stripInstalled = false;
        }
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
    return Date.now() - job.startTime;
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

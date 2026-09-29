/**
 * Completion-notice rendering — the only module that turns a finished `Job`
 * or a monitor's terminal event into a string the agent sees.
 *
 * Owned by notice.ts so the format module stays focused on primitives
 * (duration strings, status pills, output tails) and there's a single
 * source of truth for the agent-facing copy. notify.ts owns the
 * coalesce/flush lifecycle and calls into here at turn boundaries.
 */

import type { Job, MonitorEnd } from "./types.ts";
import { formatDuration } from "./format.ts";

/** Tool-call pseudo-syntax for the `jobs` tool — single source of truth so the
 *  completion notice nudge and any future UI surfaces stay in sync with the
 *  tool's parameter shape. The id is sanitized in case persisted state or
 *  external reconstruction ever surfaces a non-conformant one. */
function jobsOutputInvocation(jobId: string): string {
    const safe = jobId.replace(/["\\\n\r]/g, "?");
    return `jobs({ action: "output", jobId: "${safe}" })`;
}

/** Label for a job in a completion notice. Named jobs use their name; unnamed
 *  jobs get a short command preview (in quotes so it parses as a single token
 *  to the agent); empty command falls back to the id. Quoted/unquoted forms
 *  also tell the agent at a glance which it is. */
export function jobNoticeLabel(job: Job): string {
    if (job.name) return job.name;
    if (job.command) return `"${job.command.slice(0, 60)}"`;
    return job.id;
}

/** Glyph for a finished job's status. Killed is distinct from failed. */
export function jobGlyph(job: Job): string {
    return job.status === "completed" ? "✓" : job.status === "killed" ? "⊘" : "✗";
}

/** Suffix that explains WHY a job is non-completed: exit code, killed marker,
 *  or just "failed" when the failure has no exit code. Successful jobs have no
 *  suffix. */
export function statusTail(job: Job): string {
    if (job.status === "completed") return "";
    if (job.status === "killed") return ", killed";
    if (job.exitCode === undefined || job.exitCode === 0) return ", failed";
    return `, exit ${job.exitCode}`;
}

/** One short status line for a finished job — glyph, label, duration, id.
 *  No nudge here; nudgeLine pairs with this in both single and multi-job
 *  notices so the steering prompt can't be visually buried. */
export function statusLine(job: Job): string {
    const duration = formatDuration((job.endedAt ?? Date.now()) - job.startTime);
    return `${jobGlyph(job)} ${jobNoticeLabel(job)} (${duration}${statusTail(job)}, ${job.id})`;
}

/** The steering line — the explicit tool call the agent should make next.
 *
 * Parity with Claude Code: a `completed` job is reported as a bare status
 * line (its summary is the result — nothing more to do). Killed jobs are
 * intentional cleanup the agent already knows about. Only a *failed* job
 * needs the agent's attention, so only failures carry the nudge. This stops
 * the agent from reflexively calling `jobs output` on every successful
 * completion just because the notice told it to.
 * Returns null to signal "no nudge line." */
export function nudgeLine(job: Job): string | null {
    if (job.status !== "failed") return null;
    return `  → ${jobsOutputInvocation(job.id)}`;
}

/** Body lines for one job in a notice: status line plus an optional nudge. */
export function jobNoticeLines(job: Job): string[] {
    const nudge = nudgeLine(job);
    return nudge ? [statusLine(job), nudge] : [statusLine(job)];
}

/** `◉ desc — summary` — one line for a monitor terminal notice. */
export function formatMonitorLine(end: MonitorEnd): string {
    return `◉ ${end.description} — ${end.summary}`;
}

/** Sort jobs so the most-failed are listed first in the notice. */
function sortJobsForNotice(jobs: Job[]): Job[] {
    return [...jobs].sort((a, b) => {
        const rank = (j: Job) =>
            j.status === "completed" ? 2 : j.status === "killed" ? 1 : 0;
        return rank(a) - rank(b);
    });
}

/** Build the headline summary (counts). With nothing to surface, returns an
 *  empty string so callers can skip it cleanly. */
export function headline(jobs: Job[], monitors: MonitorEnd[]): string {
    const parts: string[] = [];
    if (jobs.length > 0) {
        const failed = jobs.filter((j) => j.status === "failed").length;
        const killed = jobs.filter((j) => j.status === "killed").length;
        let text = `${jobs.length} background job${jobs.length > 1 ? "s" : ""} finished`;
        const tail: string[] = [];
        if (failed > 0) tail.push(`${failed} failed`);
        if (killed > 0) tail.push(`${killed} killed`);
        if (tail.length > 0) text += ` (${tail.join(", ")})`;
        parts.push(text);
    }
    if (monitors.length > 0) {
        const failedM = monitors.filter((m) => m.failed).length;
        let text = `${monitors.length} monitor${monitors.length > 1 ? "s" : ""} ended`;
        if (failedM > 0) text += ` (${failedM} failed)`;
        parts.push(text);
    }
    return parts.join(". ");
}

/** Format any combination of finished jobs + monitor-terminal notices into the
 *  single string the agent sees. Always goes through the unified headline+lines
 *  shape so the 1-job+1-monitor case doesn't silently drop one of them. */
export function formatNotices(jobs: Job[], monitors: MonitorEnd[]): string {
    if (jobs.length === 0 && monitors.length === 0) return "";

    const sortedJobs = sortJobsForNotice(jobs);
    const jobBody = sortedJobs.flatMap(jobNoticeLines);
    const monitorBody = monitors.map(formatMonitorLine);

    return [headline(jobs, monitors), ...jobBody, ...monitorBody]
        .filter((s) => s.length > 0)
        .join("\n");
}

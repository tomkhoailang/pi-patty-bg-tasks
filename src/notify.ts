/**
 * Coalesced background-job notices.
 *
 * Background jobs and monitors finish at all sorts of times during a long agent
 * turn. Sent individually, their notices queue in Pi and dump as a WALL after
 * the agent's next reply. So instead we accumulate every completion +
 * monitor-terminal notice and flush ONE summary after a short coalescing window.
 *
 * Delivery follows docs/antigravity-background-tasks.md §8 Q3: a MID-TURN notice
 * is injected as a steer, which lands before the agent's next LLM call — a call
 * it was going to make anyway — so it costs no extra turn. Waking an IDLE agent
 * does cost one, so it is reserved for terminal notices.
 *
 * Monitor *stream* events (matched log lines) are NOT routed here — they carry
 * data the agent is actively watching and stay live. Only the terminal/status
 * notices (stream ended / stopped / failed) and job completions coalesce.
 *
 * Jobs whose output was already consumed (e.g. via a jobs attach) never enqueue.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    DELIVER_FOLLOWUP,
    DELIVER_STEER,
    EVENT,
    JOB_FINISH_COALESCE_MS,
    NOTIFY_POLICY,
    type Job,
    type MonitorEnd,
    type UiContext,
} from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import { formatNotices } from "./notice.ts";
import { policyAllowsTerminal } from "./notify-policy.ts";

/**
 * Choose how a notice is delivered (§8 Q3).
 *
 * Mid-turn injection is effectively free: a steer is queued and delivered after
 * the current tool calls, before the next LLM call — no extra turn. Idle, the
 * only way to be heard is to trigger a turn, so that is spent only when the
 * caller says the message is worth a turn (`wakeWhenIdle`).
 */
export function pickDelivery(
    reg: BackgroundRegistry,
    opts: { wakeWhenIdle: boolean }
): typeof DELIVER_STEER | typeof DELIVER_FOLLOWUP {
    return reg.agentBusy || opts.wakeWhenIdle ? DELIVER_STEER : DELIVER_FOLLOWUP;
}

/** Queue a finished job for the next coalesced notice. */
export function enqueueFinished(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext,
    job: Job
): void {
    if (job.outputConsumed) return; // already surfaced via attach
    // The policy decides whether this class of news reaches the agent at all
    // (`PI_PATTY_BG_NOTIFY=off|error|result|concise|all`). The banner and the
    // monitor's history are untouched — only the notice channel is gated.
    if (!policyAllowsTerminal(job.status, NOTIFY_POLICY)) return;
    // Stamp the finish time now (≈ completion) so the reported duration isn't
    // inflated by however long the notice waits for the turn boundary.
    job.endedAt ??= Date.now();
    reg.pendingFinished.push(job);
    armIdleFlush(reg, pi, ctx);
}

/** Queue a monitor's terminal notice (stream ended / stopped / failed). */
export function enqueueMonitorEnd(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext,
    end: MonitorEnd
): void {
    if (NOTIFY_POLICY === "off") return;
    reg.pendingMonitorEnds.push(end);
    armIdleFlush(reg, pi, ctx);
}

/**
 * Arm the coalescing flush.
 *
 * It runs on a short timer REGARDLESS of whether the agent is busy — that is the
 * point of §8 Q3: while the agent works, the notice is injected into the turn
 * already in flight instead of being parked until `agent_end`, which is what
 * used to force the agent to poll if it needed the news sooner.
 */
function armIdleFlush(reg: BackgroundRegistry, pi: ExtensionAPI, ctx: UiContext): void {
    if (reg.noticeFlushTimer) return;
    const timer = setTimeout(
        () => flushIdleNotices(reg, pi, ctx),
        JOB_FINISH_COALESCE_MS
    );
    (timer as NodeJS.Timeout).unref();
    reg.noticeFlushTimer = timer;
}

/**
 * Agent started a turn: drain anything still pending (in case a previous turn
 * threw before its agent_end and stranded notices), then hold new notices until
 * this turn ends. The drain is a no-op on the happy path (buffers empty).
 * Drain path uses the turn-boundary shape (no wake) — a stranded batch from a
 * prior turn should not autonomously start a new turn.
 */
export function noteAgentStart(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    flushTurnBoundaryNotices(reg, pi, ctx);
    reg.agentBusy = true;
    clearFlushTimer(reg);
}

/** Agent finished a turn: flush everything that accumulated as one summary.
 *  Uses the turn-boundary shape (no wake) — waking here would spawn an
 *  unsolicited follow-up turn that defeats coalescing. */
export function noteAgentEnd(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    reg.agentBusy = false;
    flushTurnBoundaryNotices(reg, pi, ctx);
}

/** Idle-path flush: wakes the agent via a steer so the agent actually reacts
 *  to the finished job (the user isn't engaged to prompt otherwise). */
export function flushIdleNotices(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    // Terminal news is worth a turn when the agent is otherwise idle.
    sendCoalescedNotice(reg, pi, ctx, pickDelivery(reg, { wakeWhenIdle: true }));
}

/** Turn-boundary flush: passive follow-up. No wake — the agent just finished
 *  a turn and waking here would spawn an unsolicited follow-up turn. */
export function flushTurnBoundaryNotices(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    sendCoalescedNotice(reg, pi, ctx, DELIVER_FOLLOWUP);
}

/** Shared flush body. Drains the pending buffers and emits the notice. If
 *  either `notify` or `sendMessage` throws (typically a stale ctx after a
 *  session switch), the drained items are re-queued at the head of the
 *  pending buffers so the next attempt can retry them — preventing silent
 *  loss of completion notices.
 *
 *  Re-checks `outputConsumed` AFTER draining. A job can be enqueued while the
 *  agent is mid-turn (outputConsumed still unset) and then have its outcome
 *  learned via `jobs output` / `job_decide` later in the SAME turn, flipping
 *  the flag while the job is parked in the buffer. Without this flush-time
 *  filter, the turn-end notice would re-tell the agent about a job it just
 *  handled — the exact redundancy this module exists to prevent. Already-
 *  consumed jobs are dropped, never re-queued. */
function sendCoalescedNotice(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext,
    deliver: typeof DELIVER_STEER | typeof DELIVER_FOLLOWUP
): void {
    clearFlushTimer(reg);
    const monitors = reg.pendingMonitorEnds;
    // Flush-time suppression: drop jobs the agent already learned the outcome
    // of while they were parked here (Claude Code's `notified`-flag parity).
    const jobs = reg.pendingFinished.filter((j) => !j.outputConsumed);
    if (jobs.length === 0 && monitors.length === 0) {
        reg.pendingFinished = [];
        reg.pendingMonitorEnds = [];
        return;
    }
    reg.pendingFinished = [];
    reg.pendingMonitorEnds = [];

    const { content, level } = formatNotices(jobs, monitors);

    try {
        ctx.ui.notify(content, level);
    } catch (err) {
        // Banner failed (typically a stale ctx after a session switch/fork).
        // Re-queue at the head so the next flush attempt can retry, and bail
        // — if the UI is stale, sendMessage is almost certainly stale too.
        requeueHead(reg, jobs, monitors);
        log.error("[bg-tasks] notice dropped, re-queued:", err);
        return;
    }

    try {
        pi.sendMessage(
            {
                customType: EVENT.jobFinished,
                content,
                display: true,
                details: {
                    jobCount: jobs.length,
                    monitorCount: monitors.length,
                    jobs: jobs.map((j) => ({
                        jobId: j.id,
                        status: j.status,
                        exitCode: j.exitCode,
                        command: j.command,
                        logPath: j.logPath,
                    })),
                    monitors: monitors.map((m) => ({ description: m.description, summary: m.summary })),
                },
            },
            deliver
        );
    } catch (err) {
        // Banner went out but the agent didn't get the message. Re-queue at
        // the head so a retry surfaces the notice to the agent on the next
        // pass.
        requeueHead(reg, jobs, monitors);
        log.error("[bg-tasks] sendMessage failed, notice re-queued:", err);
        return;
    }
}

/** Prepend drained jobs + monitors back onto the pending buffers so the next
 *  flush attempt retries them. Centralized so a future code path can't
 *  accidentally forget one of the two buffers. */
function requeueHead(
    reg: BackgroundRegistry,
    jobs: readonly Job[],
    monitors: readonly MonitorEnd[]
): void {
    if (jobs.length) reg.pendingFinished = [...jobs, ...reg.pendingFinished];
    if (monitors.length) reg.pendingMonitorEnds = [...monitors, ...reg.pendingMonitorEnds];
}

/** Logger hook for the re-queue paths. Tests swap `log` for a no-op so the
 *  throw-path tests don't pollute test output; production keeps it as
 *  `console.error`. Mutable so `setLogger` can swap at runtime. */
interface Logger {
    error(...args: unknown[]): void;
}
let log: Logger = {
    error: (...args: unknown[]): void => console.error(...args),
};
/** Swap the logger (used by tests). Pass `null` to restore the default. */
export function setLogger(next: Logger | null): void {
    log = next ?? { error: (...args: unknown[]): void => console.error(...args) };
}

/** Cancel any pending notices without flushing (session shutdown). */
export function cancelPendingNotices(reg: BackgroundRegistry): void {
    clearFlushTimer(reg);
    reg.pendingFinished = [];
    reg.pendingMonitorEnds = [];
}

function clearFlushTimer(reg: BackgroundRegistry): void {
    if (reg.noticeFlushTimer) {
        clearTimeout(reg.noticeFlushTimer);
        reg.noticeFlushTimer = undefined;
    }
}

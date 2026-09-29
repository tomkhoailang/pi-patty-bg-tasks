/**
 * The clock.
 *
 * A schedule is a **job of kind "timer"**: no process, no log, just a due time.
 * Building it that way is what makes it cheap — the registry, the strip, the
 * monitor modal, `jobs list|kill`, the runtime record, the session snapshot and
 * the orphan reaper all already work on jobs, so the scheduler adds only a clock
 * and a fire path.
 *
 * Firing reuses the delivery rules from notify.ts (`pickDelivery`): a fire while
 * the agent is mid-turn is injected into the run already in flight, and an idle
 * fire wakes it — which is the entire point of a schedule, so it is allowed to
 * spend that turn. Fires that come due together are coalesced into one message;
 * a fire never carries another job's raw output.
 *
 * Durability: the timer lives in the snapshot like any job. On restore, a missed
 * window **collapses to one late fire** — replaying every missed tick would turn a
 * laptop lid closed for an hour into a wall of turns.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import {
    EVENT,
    SCHED_MAX_FIRES_PER_TICK,
    SCHED_TICK_MS,
    type Job,
    type TimerSpec,
    type UiContext,
} from "./types.ts";
import { pickDelivery } from "./notify.ts";
import { jobLabel } from "./format.ts";
import { add, nextJobId, renderSidebar } from "./registry.ts";
import { markTerminal } from "./lifecycle.ts";

/** `10m`, `90s`, `2h`, `1d` → milliseconds. Null when it is not a duration. */
export function parseDuration(text: string): number | null {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/.exec(text);
    if (!m) return null;
    const value = Number(m[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    const unit = m[2] ?? "s";
    const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
    return Math.round(value * scale);
}

// --- cron subset ----------------------------------------------------------

/** One field: `*`, `5`, `5,10`, `1-5`, `*​/15`, `1-30/5`. */
function parseField(field: string, min: number, max: number): number[] | null {
    const out = new Set<number>();
    for (const part of field.split(",")) {
        const [range, stepText] = part.split("/");
        const step = stepText === undefined ? 1 : Number(stepText);
        if (!Number.isInteger(step) || step <= 0) return null;
        let lo: number;
        let hi: number;
        if (range === "*" || range === "") {
            lo = min;
            hi = max;
        } else if (range!.includes("-")) {
            const [a, b] = range!.split("-");
            lo = Number(a);
            hi = Number(b);
        } else {
            lo = Number(range);
            hi = lo;
        }
        if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
        if (lo < min || hi > max || lo > hi) return null;
        for (let v = lo; v <= hi; v += step) out.add(v);
    }
    return out.size ? [...out].sort((a, b) => a - b) : null;
}

/**
 * Next fire time for a 5-field cron expression (`minute hour day-of-month month
 * day-of-week`), searched minute by minute for at most a year. Supports `*`,
 * `a`, `a,b`, `a-b` and `/step` in every field; day-of-week is 0–6 with Sunday 0
 * (7 also accepted). Returns null when the expression is invalid or never matches.
 */
export function nextCronTime(expr: string, from = Date.now()): number | null {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return null;
    const mins = parseField(fields[0]!, 0, 59);
    const hours = parseField(fields[1]!, 0, 23);
    const doms = parseField(fields[2]!, 1, 31);
    const months = parseField(fields[3]!, 1, 12);
    const rawDow = fields[4]!.replace(/\b7\b/g, "0");
    const dows = parseField(rawDow, 0, 6);
    if (!mins || !hours || !doms || !months || !dows) return null;

    const start = new Date(from);
    start.setSeconds(0, 0);
    const cursor = new Date(start.getTime() + 60_000); // strictly in the future
    const limit = cursor.getTime() + 366 * 24 * 60 * 60 * 1000;
    while (cursor.getTime() < limit) {
        if (
            mins.includes(cursor.getMinutes()) &&
            hours.includes(cursor.getHours()) &&
            doms.includes(cursor.getDate()) &&
            months.includes(cursor.getMonth() + 1) &&
            dows.includes(cursor.getDay())
        ) {
            return cursor.getTime();
        }
        cursor.setMinutes(cursor.getMinutes() + 1);
    }
    return null;
}

/** Resolve a schedule request into a first fire time + repeat interval. */
export function resolveSchedule(input: {
    in?: string;
    at?: string;
    every?: string;
    now?: number;
}): { fireAt: number; everyMs?: number } | { error: string } {
    const now = input.now ?? Date.now();
    if (input.in && input.at) return { error: "Give either `in` or `at`, not both." };

    if (input.in) {
        const ms = parseDuration(input.in);
        if (ms === null) return { error: `Cannot read \`in: "${input.in}"\` — use 30s, 10m, 2h.` };
        return { fireAt: now + ms };
    }
    if (input.at) {
        const at = Date.parse(input.at);
        if (Number.isNaN(at)) return { error: `Cannot read \`at: "${input.at}"\` — use an ISO time.` };
        return { fireAt: at };
    }
    if (input.every) {
        const asDuration = parseDuration(input.every);
        if (asDuration !== null) return { fireAt: now + asDuration, everyMs: asDuration };
        const next = nextCronTime(input.every, now);
        if (next === null) return { error: `Cannot read \`every: "${input.every}"\` as a duration or 5-field cron.` };
        return { fireAt: next, everyMs: next - now };
    }
    return { error: "Give `in`, `at` or `every`." };
}

// --- the clock ------------------------------------------------------------

/** Describe a timer for the UI row. */
export function timerLabel(spec: TimerSpec): string {
    const what = spec.prompt ?? spec.reason ?? "wake";
    if (spec.everyMs) return `every ${Math.round(spec.everyMs / 1000)}s: ${what}`;
    return `once in ${Math.round((spec.fireAt - Date.now()) / 1000)}s: ${what}`;
}

export function createTimerJob(reg: BackgroundRegistry, spec: TimerSpec): Job {
    const id = nextJobId(reg);
    const job: Job = {
        id,
        name: spec.reason ?? "schedule",
        command: timerLabel(spec),
        pid: 0,
        startTime: Date.now(),
        status: "running",
        logPath: "",
        toolCallId: "schedule",
        isBackgrounded: true,
        kind: "timer",
        fireAt: spec.fireAt,
        everyMs: spec.everyMs,
        prompt: spec.prompt,
        reason: spec.reason,
        maxFires: spec.maxFires,
        cancelOnActivity: spec.cancelOnActivity,
        fired: 0,
    };
    return add(reg, job);
}

/** One fire: notify, optionally inject the prompt, then advance or end. */
function fire(reg: BackgroundRegistry, pi: ExtensionAPI, ctx: UiContext, job: Job, late: boolean): void {
    job.fired = (job.fired ?? 0) + 1;
    const when = late ? " (late — pi was not running at the scheduled time)" : "";
    const body =
        `Scheduled ${jobLabel(job)} fired${when}.\n` +
        (job.prompt ? `Prompt: ${job.prompt}\n` : "") +
        `Fires so far: ${job.fired}${job.maxFires ? `/${job.maxFires}` : ""}. Cancel with jobs({ action: "kill", jobId: "${job.id}" }).`;

    try {
        ctx.ui.notify(body, "info");
    } catch {
        /* stale ctx */
    }

    const deliver = pickDelivery(reg, { wakeWhenIdle: true });
    if (job.prompt) {
        // A prompt is the schedule's whole point: it must wake the agent, so it
        // goes in as a user-shaped message (ScheduleWakeup's `prompt` equivalent).
        pi.sendUserMessage(job.prompt, { deliverAs: "steer" });
    } else {
        pi.sendMessage(
            {
                customType: EVENT.scheduleFired,
                content: body,
                display: true,
                details: { jobId: job.id, fires: job.fired },
            },
            deliver
        );
    }

    if (job.everyMs && (job.maxFires === undefined || job.fired < job.maxFires)) {
        job.fireAt = (job.fireAt ?? Date.now()) + job.everyMs;
        // A long sleep (laptop shut, pi busy) must not replay every missed tick.
        const now = Date.now();
        if (job.fireAt < now) job.fireAt = now + job.everyMs;
    } else {
        markTerminal(job, "completed");
        reg.jobs.delete(job.id);
        reg.recentTerminal.push(job);
    }
}

/**
 * Start the clock. Returns a stop function for session shutdown.
 *
 * The tick is cheap: a filter over `reg.jobs` for due timers, and a no-op when
 * there are none.
 */
export function startScheduler(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext,
    /** Tick override for tests; production uses SCHED_TICK_MS. */
    opts?: { tickMs?: number }
): () => void {
    const timer = setInterval(() => {
        try {
            const now = Date.now();
            const due = [...reg.jobs.values()].filter(
                (j) => j.kind === "timer" && j.status === "running" && (j.fireAt ?? 0) <= now
            );
            if (due.length === 0) return;
            // A fire is a wake, so a burst is a wall of turns: cap how many can fire
            // in one tick and let the rest wait for the next one.
            for (const job of due.slice(0, SCHED_MAX_FIRES_PER_TICK)) {
                fire(reg, pi, ctx, job, false);
            }
            renderSidebar(reg, ctx);
        } catch {
            // A stale ctx (session switch/fork) must not throw out of the interval
            // and take the process down; the next session restarts the clock.
        }
    }, opts?.tickMs ?? SCHED_TICK_MS);
    timer.unref();
    return () => clearInterval(timer);
}

/** Fire anything already overdue — a restored schedule whose time passed while
 *  pi was not running. One fire per timer, marked late. */
export function fireMissedSchedules(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    const now = Date.now();
    const missed = [...reg.jobs.values()].filter(
        (j) => j.kind === "timer" && j.status === "running" && (j.fireAt ?? 0) <= now
    );
    if (missed.length === 0) return;
    for (const job of missed.slice(0, SCHED_MAX_FIRES_PER_TICK)) {
        fire(reg, pi, ctx, job, true);
    }
}

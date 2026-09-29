// src/__tests__/scheduler.test.ts
//
// The clock. A schedule is a JOB of kind "timer" — no process, just a due time —
// so these cover the pieces that are new: parsing (duration + cron subset),
// firing (advance/stop/cap), late-collapse on restore, and cancelOnActivity.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundRegistry } from "../state.ts";
import {
    createTimerJob,
    fireMissedSchedules,
    nextCronTime,
    parseDuration,
    resolveSchedule,
    startScheduler,
} from "../scheduler.ts";
import { setTimeout as delay } from "node:timers/promises";
import type { UiContext } from "../types.ts";

const ctx = {
    mode: "tui",
    ui: {
        theme: { fg: (_c: string, t: string) => t },
        notify: () => {},
        setWidget: () => {},
        setStatus: () => {},
    },
} as unknown as UiContext;

const TICK = 15;

function harness() {
    const messages: string[] = [];
    const prompts: string[] = [];
    const pi = {
        sendMessage: (m: { content: string }) => messages.push(m.content),
        sendUserMessage: (t: string) => prompts.push(t),
    };
    return { reg: new BackgroundRegistry(), pi, messages, prompts };
}

describe("schedule parsing", () => {
    test("durations", () => {
        assert.equal(parseDuration("30s"), 30_000);
        assert.equal(parseDuration("10m"), 600_000);
        assert.equal(parseDuration("2h"), 7_200_000);
        assert.equal(parseDuration("1d"), 86_400_000);
        assert.equal(parseDuration("500ms"), 500);
        assert.equal(parseDuration("nope"), null);
        assert.equal(parseDuration("-5m"), null);
    });

    test("cron subset: *, */n, lists, ranges", () => {
        // cron is LOCAL time by convention, so expectations are built locally.
        const local = (h: number, m = 0) => new Date(2026, 8, 29, h, m, 0, 0).getTime();
        const base = local(10);
        assert.equal(nextCronTime("*/15 * * * *", base), local(10, 15), "every 15m");
        assert.equal(nextCronTime("30 11 * * *", base), local(11, 30), "specific minute+hour");
        assert.equal(nextCronTime("0 9,11 * * *", base), local(11), "hour list");
        assert.equal(nextCronTime("0 8-12/2 * * *", base), local(12), "hour range with step");
        const sunday = nextCronTime("0 0 * * 0", base);
        assert.ok(sunday !== null, "dow match");
        assert.equal(new Date(sunday).getDay(), 0, "Sunday");
        assert.equal(nextCronTime("0 0 * * 7", base), sunday, "7 also means Sunday");
        // invalid
        assert.equal(nextCronTime("*/0 * * * *", base), null);
        assert.equal(nextCronTime("99 * * * *", base), null);
        assert.equal(nextCronTime("* * * *", base), null);
    });

    test("resolveSchedule prefers `in`/`at` for one-shots, `every` for repeats", () => {
        const now = 1_000_000;
        assert.deepEqual(resolveSchedule({ in: "1m", now }), { fireAt: now + 60_000 });
        assert.deepEqual(resolveSchedule({ at: "2026-09-29T10:00:00Z", now }), {
            fireAt: Date.parse("2026-09-29T10:00:00Z"),
        });
        const every = resolveSchedule({ every: "5m", now });
        assert.deepEqual(every, { fireAt: now + 300_000, everyMs: 300_000 });
        const cron = resolveSchedule({ every: "*/30 * * * *", now });
        assert.ok("fireAt" in cron && cron.everyMs! > 0 && cron.everyMs! <= 30 * 60_000);
        assert.ok("error" in resolveSchedule({ in: "5", at: "x" }));
        assert.ok("error" in resolveSchedule({}));
        assert.ok("error" in resolveSchedule({ every: "banana" }));
    });
});

describe("the clock", () => {
    test("a one-shot fires once and becomes terminal", async () => {
        const h = harness();
        const job = createTimerJob(h.reg, { fireAt: Date.now() + 40 });
        const stop = startScheduler(h.reg, h.pi as never, ctx, { tickMs: TICK });
        try {
            await delay(120);
            assert.equal(h.messages.length, 1, "one notice");
            assert.match(h.messages[0]!, /fired/);
            assert.equal(h.reg.jobs.has(job.id), false, "no longer running");
            assert.equal(job.status, "completed");
            await delay(80);
            assert.equal(h.messages.length, 1, "no second fire");
        } finally {
            stop();
        }
    });

    test("a recurring timer advances and stops at maxFires", async () => {
        const h = harness();
        const job = createTimerJob(h.reg, { fireAt: Date.now() + 30, everyMs: 30, maxFires: 2 });
        const stop = startScheduler(h.reg, h.pi as never, ctx, { tickMs: TICK });
        try {
            await delay(250);
            assert.ok(h.messages.length >= 2, `fired: ${h.messages.length}`);
            assert.equal(job.fired, 2);
            assert.equal(h.reg.jobs.has(job.id), false, "stopped at maxFires");
        } finally {
            stop();
        }
    });

    test("a prompt fire runs the prompt and wakes the agent", async () => {
        const h = harness();
        createTimerJob(h.reg, { fireAt: Date.now() + 30, prompt: "re-check the deploy" });
        const stop = startScheduler(h.reg, h.pi as never, ctx, { tickMs: TICK });
        try {
            await delay(120);
            assert.deepEqual(h.prompts, ["re-check the deploy"]);
        } finally {
            stop();
        }
    });

    test("a restored overdue timer fires ONCE, marked late", () => {
        const h = harness();
        const job = createTimerJob(h.reg, { fireAt: Date.now() - 3_600_000, everyMs: 60_000 });
        fireMissedSchedules(h.reg, h.pi as never, ctx);
        assert.equal(h.messages.length, 1, "one late fire, not 60");
        assert.match(h.messages[0]!, /late/);
        assert.equal(job.fired, 1);
        assert.ok((job.fireAt ?? 0) > Date.now(), "next window is in the future");
    });

    test("a timer can be cancelled with jobs kill (status change)", async () => {
        const h = harness();
        const job = createTimerJob(h.reg, { fireAt: Date.now() + 50 });
        const stop = startScheduler(h.reg, h.pi as never, ctx, { tickMs: TICK });
        try {
            job.status = "killed";
            await delay(120);
            assert.equal(h.messages.length, 0, "a killed timer never fires");
        } finally {
            stop();
        }
    });
});

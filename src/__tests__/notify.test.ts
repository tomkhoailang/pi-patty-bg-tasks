import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BackgroundRegistry } from "../state.ts";
import {
    cancelPendingNotices,
    enqueueFinished,
    enqueueMonitorEnd,
    flushIdleNotices,
    flushTurnBoundaryNotices,
    noteAgentEnd,
    noteAgentStart,
    setLogger,
} from "../notify.ts";
import { markOutcomeKnown, markTerminal } from "../lifecycle.ts";
import { type Job, type UiContext } from "../types.ts";

interface Captured {
    customType: string;
    content: string;
    level?: string;
    details?: { jobCount?: number; monitorCount?: number };
}

interface DeliverOpts {
    deliverAs: "steer" | "followUp";
    triggerTurn: boolean;
}

function harness(opts?: { deliverThrows?: boolean; notifyThrows?: boolean }) {
    const messages: Captured[] = [];
    const deliverOptions: DeliverOpts[] = [];
    const notices: { content: string; level?: string }[] = [];
    const pi = {
        sendMessage: (m: Captured, o?: DeliverOpts) => {
            if (opts?.deliverThrows) throw new Error("sendMessage failed");
            messages.push(m);
            if (o) deliverOptions.push(o);
        },
    };
    const ctx = {
        ui: {
            notify: (content: string, level?: string) => {
                if (opts?.notifyThrows) throw new Error("notify failed");
                notices.push({ content, level });
            },
        },
    } as unknown as UiContext;
    return {
        reg: new BackgroundRegistry(),
        pi,
        ctx,
        messages,
        deliverOptions,
        notices,
    };
}

function mkJob(over: Partial<Job>): Job {
    return {
        id: "job-1-1",
        command: "npm test",
        pid: 100,
        startTime: Date.now(),
        status: "completed",
        logPath: "/tmp/pi-bg/job-1-1.log",
        toolCallId: "t",
        isBackgrounded: true,
        ...over,
    } as Job;
}

void describe("notify — turn-boundary coalescing", () => {
    void it("a single finished job reads like one line", () => {
        const { reg, pi, ctx, messages } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-5", name: "tests" }));
        flushTurnBoundaryNotices(reg, pi as never, ctx);
        assert.equal(messages.length, 1);
        const c = messages[0].content;
        assert.match(c, /^✓ tests \(/m);
        assert.ok(c.includes("job-1-5"), "job id appears in the status line");
    });

    void it("collapses a whole turn's finishes (spread out) into ONE summary at agent_end", () => {
        const { reg, pi, ctx, messages } = harness();
        noteAgentStart(reg, pi as never, ctx); // agent is mid-turn

        // Jobs finishing at different times during the turn — the old 400ms
        // window would never merge these; now they all wait for the turn end.
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-1", status: "completed" }));
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-2", status: "failed", exitCode: 1 }));
        enqueueMonitorEnd(reg, pi as never, ctx, { description: "API health", summary: "stream ended", failed: false });
        enqueueMonitorEnd(reg, pi as never, ctx, { description: "port 4000", summary: "stopped (timeout)", failed: false });

        assert.equal(messages.length, 0, "nothing flushes while the agent is busy");

        noteAgentEnd(reg, pi as never, ctx);

        assert.equal(messages.length, 1, "one summary at the turn boundary");
        const c = messages[0].content;
        assert.match(c, /2 background jobs finished \(1 failed\)/);
        assert.match(c, /2 monitors ended/);
        assert.match(c, /^✓ "npm test" \(/m);
        assert.match(c, /^✗ "npm test" \(.*exit 1/m);
        // Both job ids appear in their status lines.
        assert.ok(c.includes("job-1-1"), "completed job id in its status line");
        assert.ok(c.includes("job-1-2"), "failed job id in its status line");
        assert.match(c, /◉ API health — stream ended/);
        assert.match(c, /◉ port 4000 — stopped \(timeout\)/);
        // Only the failed job carries a nudge; the completed one is bare.
        const nudges = c.split("\n").filter((l) => l.includes("jobs({ action: \"output\""));
        assert.equal(nudges.length, 1, "nudge only for the failed job");
        assert.ok(nudges.some((n) => n.includes('"job-1-2"')));
    });

    void it("never steers: a notice is ours, not the user's", async () => {
        const { reg, pi, ctx, messages, deliverOptions } = harness();
        noteAgentStart(reg, pi as never, ctx);
        enqueueFinished(reg, pi as never, ctx, mkJob({}));
        await new Promise((r) => setTimeout(r, 600));
        // pi presents a `steer` as user-shaped input, so a steered notice reads as
        // if the user had typed it. Notices always go out as followUp.
        assert.equal(messages.length, 1, "flushed after the coalescing window");
        assert.equal(deliverOptions[0]?.deliverAs, "followUp");
        assert.notEqual(deliverOptions[0]?.deliverAs, "steer");
        noteAgentEnd(reg, pi as never, ctx);
        assert.equal(messages.length, 1, "nothing left to flush at the boundary");
    });

    void it("wakes an idle agent without impersonating it", async () => {
        const { reg, pi, ctx, messages, deliverOptions } = harness();
        // agent idle (agentBusy=false by default)
        enqueueFinished(reg, pi as never, ctx, mkJob({}));
        await new Promise((r) => setTimeout(r, 600));
        assert.equal(messages.length, 1);
        assert.equal(deliverOptions[0]?.deliverAs, "followUp", "still our block");
        assert.equal(deliverOptions[0]?.triggerTurn, true, "but it wakes the agent");
    });

    void it("while idle, a finish flushes via the fallback timer (coalesced)", async () => {
        const { reg, pi, ctx, messages } = harness();
        // agent idle (agentBusy=false by default)
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-1" }));
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-2" }));
        assert.equal(messages.length, 0, "not flushed immediately");
        await new Promise((r) => setTimeout(r, 600));
        assert.equal(messages.length, 1, "one coalesced flush after the idle window");
        const c = messages[0].content;
        assert.match(c, /2 background jobs finished/);
        // Completed jobs carry no nudge (Claude Code parity) — they're reported
        // as bare status lines. The agent only needs to act on failures.
        const nudges = c.split("\n").filter((l) => l.includes("jobs({ action: \"output\""));
        assert.equal(nudges.length, 0);
    });

    void it("noteAgentStart drains stranded notices, then flushes new ones mid-turn", async () => {
        const { reg, pi, ctx, messages } = harness();
        // Simulate notices left pending by a prior turn that threw before agent_end.
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-stranded" }));
        noteAgentStart(reg, pi as never, ctx); // drains the stranded notice up front
        assert.equal(messages.length, 1, "stranded notice flushed at turn start");

        // New finishes during this turn are flushed as our own block.
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-new" }));
        await new Promise((r) => setTimeout(r, 600));
        assert.equal(messages.length, 2, "new notice flushed mid-turn");
        noteAgentEnd(reg, pi as never, ctx);
        assert.equal(messages.length, 2, "nothing left for the turn boundary");
    });

    void it("only failed jobs carry an output-read nudge (completed are bare)", () => {
        const { reg, pi, ctx, messages } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-1", status: "completed" }));
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-2", status: "failed", exitCode: 2 }));
        flushTurnBoundaryNotices(reg, pi as never, ctx);
        const c = messages[0].content;
        const nudges = c.split("\n").filter((l) => l.includes("jobs({ action: \"output\""));
        assert.equal(nudges.length, 1, "nudge only for the failed job");
        assert.ok(!nudges.some((n) => n.includes('"job-1-1"')));
        assert.ok(nudges.some((n) => n.includes('"job-1-2"')));
    });

    void it("a lone monitor end reads like one line", () => {
        const { reg, pi, ctx, messages } = harness();
        enqueueMonitorEnd(reg, pi as never, ctx, { description: "deploy", summary: "stream ended", failed: false });
        flushTurnBoundaryNotices(reg, pi as never, ctx);
        assert.equal(messages.length, 1);
        assert.match(messages[0].content, /◉ deploy — stream ended/);
    });

    void it("a killed job is reported without a nudge (intentional cleanup)", () => {
        const { reg, pi, ctx, messages, notices } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-1", status: "killed" }));
        flushTurnBoundaryNotices(reg, pi as never, ctx);
        const c = messages[0].content;
        assert.match(c, /^⊘ /m, "uses the kill glyph, not the failure glyph");
        assert.match(c, /, killed/);
        assert.equal(
            c.split("\n").filter((l) => l.includes("jobs({ action: \"output\"")).length,
            0,
            "no nudge for a killed job"
        );
        assert.equal(notices[0].level, "info", "killed is not an error");
    });

    void it("a failed job without an exitCode is labeled clearly", () => {
        const { reg, pi, ctx, messages } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-1", status: "failed" }));
        flushTurnBoundaryNotices(reg, pi as never, ctx);
        assert.match(messages[0].content, /^✗ /m);
        assert.match(messages[0].content, /, failed\b/);
    });

    void it("an unnamed job shows a command preview, not just the id", () => {
        const { reg, pi, ctx, messages } = harness();
        enqueueFinished(
            reg,
            pi as never,
            ctx,
            mkJob({ id: "job-7-9", command: "npm run e2e --reporter=spec" })
        );
        flushTurnBoundaryNotices(reg, pi as never, ctx);
        assert.match(messages[0].content, /npm run e2e/);
    });

    void it("1 job + 1 monitor is reported together (no silent drop)", () => {
        const { reg, pi, ctx, messages } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-1" }));
        enqueueMonitorEnd(reg, pi as never, ctx, { description: "deploy", summary: "stream ended", failed: false });
        flushTurnBoundaryNotices(reg, pi as never, ctx);
        const c = messages[0].content;
        assert.match(c, /1 background job finished/);
        assert.match(c, /1 monitor ended/);
        assert.match(c, /✓ "npm test" \(/);
        assert.match(c, /◉ deploy — stream ended/);
    });

    void it("monitor failures show up in the headline count", () => {
        const { reg, pi, ctx, messages } = harness();
        enqueueMonitorEnd(reg, pi as never, ctx, { description: "a", summary: "ok", failed: false });
        enqueueMonitorEnd(reg, pi as never, ctx, { description: "b", summary: "died", failed: true });
        enqueueMonitorEnd(reg, pi as never, ctx, { description: "c", summary: "ok", failed: false });
        flushTurnBoundaryNotices(reg, pi as never, ctx);
        assert.match(messages[0].content, /3 monitors ended \(1 failed\)/);
    });

    void it("does not enqueue a job whose output was already consumed", () => {
        const { reg, pi, ctx, messages } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({ outputConsumed: true }));
        flushTurnBoundaryNotices(reg, pi as never, ctx);
        assert.equal(messages.length, 0);
        assert.equal(reg.pendingFinished.length, 0);
    });

    void it("markOutcomeKnown suppresses a later completion notice (CC `notified` parity)", () => {
        // Mirrors Claude Code's markTaskNotified: once the agent learns a job's
        // outcome through ANY path (jobs output / job_decide / attach), the
        // pending completion notice is suppressed so the agent isn't re-told
        // about something it already handled.
        const { reg, pi, ctx, messages } = harness();
        const job = mkJob({ id: "job-1-1", status: "running" });
        // Agent resolves the job via job_decide / jobs output BEFORE it would
        // finish — markOutcomeKnown records that the outcome is known.
        markOutcomeKnown(job);
        // No-op while running: the flag only sticks once the job is terminal.
        assert.equal(job.outputConsumed, undefined);
        // Now the job finishes and is enqueued for a notice…
        markTerminal(job, "completed");
        markOutcomeKnown(job);
        enqueueFinished(reg, pi as never, ctx, job);
        flushTurnBoundaryNotices(reg, pi as never, ctx);
        assert.equal(messages.length, 0, "outcome already known — no notice");
    });

    void it("markOutcomeKnown AFTER enqueue still suppresses at flush (mid-turn race)", () => {
        // The race the enqueue-time gate alone can't catch: a job completes
        // mid-turn and is parked in pendingFinished, THEN the agent reads its
        // output (jobs output / job_decide check) in the same turn — flipping
        // outputConsumed while the job is already buffered. The turn-end flush
        // must drop it, not emit it.
        const { reg, pi, ctx, messages } = harness();
        const job = mkJob({ id: "job-1-1", status: "completed" });
        noteAgentStart(reg, pi as never, ctx); // hold for the turn
        enqueueFinished(reg, pi as never, ctx, job);
        assert.equal(reg.pendingFinished.length, 1, "parked mid-turn");
        // Agent learns the outcome later in the same turn.
        markOutcomeKnown(job);
        noteAgentEnd(reg, pi as never, ctx); // turn-end flush
        assert.equal(messages.length, 0, "already-known job dropped at flush");
        assert.equal(reg.pendingFinished.length, 0, "not re-queued");
    });

    void it("flush is a no-op when nothing is pending", () => {
        const { reg, pi, ctx, messages } = harness();
        flushTurnBoundaryNotices(reg, pi as never, ctx);
        noteAgentEnd(reg, pi as never, ctx);
        assert.equal(messages.length, 0);
    });

    void it("cancelPendingNotices drops everything without emitting", () => {
        const { reg, pi, ctx, messages } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({}));
        enqueueMonitorEnd(reg, pi as never, ctx, { description: "x", summary: "stopped", failed: false });
        cancelPendingNotices(reg);
        assert.equal(reg.pendingFinished.length, 0);
        assert.equal(reg.pendingMonitorEnds.length, 0);
        assert.equal(reg.noticeFlushTimer, undefined);
        assert.equal(messages.length, 0);
    });
});

void describe("notify — wake shape per path", () => {
    // Suppress the re-queue-path log lines during the throw-path tests so test
    // output stays clean. Restore in afterEach.
    setLogger({ error: () => {} });
    void it("idle-path flush wakes the agent as our own block (never a steer)", () => {
        const { reg, pi, ctx, messages, deliverOptions } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({}));
        flushIdleNotices(reg, pi as never, ctx);
        assert.equal(messages.length, 1);
        assert.equal(deliverOptions.length, 1);
        // followUp keeps the notice a patty block; triggerTurn still wakes the
        // agent. `steer` would be presented as user-shaped input.
        assert.equal(deliverOptions[0].deliverAs, "followUp");
        assert.equal(deliverOptions[0].triggerTurn, true);
    });

    void it("turn-boundary flush is passive (no unsolicited follow-up turn)", () => {
        const { reg, pi, ctx, messages, deliverOptions } = harness();
        // Simulate the agent being mid-turn so enqueueFinished does NOT arm
        // the idle timer — we want a pure turn-boundary flush.
        reg.agentBusy = true;
        enqueueFinished(reg, pi as never, ctx, mkJob({}));
        noteAgentEnd(reg, pi as never, ctx); // agent_end → turn-boundary flush
        assert.equal(messages.length, 1);
        assert.equal(deliverOptions.length, 1);
        assert.equal(deliverOptions[0].deliverAs, "followUp");
        assert.equal(deliverOptions[0].triggerTurn, false,
            "turn-boundary notice must not spawn an unsolicited turn");
    });

    void it("noteAgentStart drain path is passive (stranded notices don't wake)", () => {
        const { reg, pi, ctx, messages, deliverOptions } = harness();
        // Stranded from a prior turn that threw before its agent_end.
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-stranded" }));
        noteAgentStart(reg, pi as never, ctx);
        assert.equal(messages.length, 1);
        assert.equal(deliverOptions[0].deliverAs, "followUp",
            "drain must not spawn an unsolicited turn");
    });

    void it("idle-path flush re-queues items when sendMessage throws (no silent loss)", () => {
        const { reg, pi, ctx, messages } = harness({ deliverThrows: true });
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-1" }));
        enqueueMonitorEnd(reg, pi as never, ctx, { description: "deploy", summary: "stream ended", failed: false });
        flushIdleNotices(reg, pi as never, ctx);
        assert.equal(messages.length, 0, "sendMessage threw — no message recorded");
        // Re-queued at the head so a retry surfaces them.
        assert.equal(reg.pendingFinished.length, 1);
        assert.equal(reg.pendingMonitorEnds.length, 1);
        assert.equal(reg.pendingFinished[0].id, "job-1-1");
    });

    void it("idle-path flush re-queues items when notify throws (no silent loss)", () => {
        const { reg, pi, ctx, messages } = harness({ notifyThrows: true });
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-1" }));
        flushIdleNotices(reg, pi as never, ctx);
        assert.equal(messages.length, 0, "sendMessage never reached");
        assert.equal(reg.pendingFinished.length, 1, "re-queued for retry");
        assert.equal(reg.pendingFinished[0].id, "job-1-1");
    });
});

/**
 * Unit tests for the completion-notice renderer (src/notice.ts).
 *
 * These are pure-function tests that cover each branch directly. Integration
 * coverage via the turn-boundary coalescer lives in src/__tests__/notify.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    formatMonitorLine,
    formatNotices,
    headline,
    jobGlyph,
    jobNoticeLabel,
    jobNoticeLines,
    nudgeLine,
    statusLine,
    statusTail,
} from "../notice.ts";
import type { Job, MonitorEnd } from "../types.ts";

function mkJob(overrides: Partial<Job> = {}): Job {
    return {
        id: "job-1-1",
        command: "npm test",
        pid: 100,
        startTime: Date.now() - 5_000,
        endedAt: Date.now(),
        status: "completed",
        logPath: "/tmp/x",
        toolCallId: "t",
        isBackgrounded: true,
        ...overrides,
    };
}

void describe("jobNoticeLabel", () => {
    void it("uses the name when set", () => {
        assert.equal(jobNoticeLabel(mkJob({ name: "tests" })), "tests");
    });
    void it("falls back to a quoted command preview for unnamed jobs", () => {
        assert.equal(
            jobNoticeLabel(mkJob({ command: "npm run e2e" })),
            '"npm run e2e"'
        );
    });
    void it("truncates long commands at 60 chars", () => {
        const long = "x".repeat(120);
        const out = jobNoticeLabel(mkJob({ command: long }));
        assert.equal(out.length, 1 + 60 + 1); // " + 60 chars + "
        assert.ok(out.endsWith('"'));
        assert.ok(out.startsWith('"'));
    });
    void it("falls back to the id when name and command are both missing", () => {
        assert.equal(
            jobNoticeLabel(mkJob({ id: "job-9-9", command: "" })),
            "job-9-9"
        );
    });
});

void describe("jobGlyph", () => {
    void it("completed → ✓", () => {
        assert.equal(jobGlyph(mkJob({ status: "completed" })), "✓");
    });
    void it("killed → ⊘ (distinct from failed)", () => {
        assert.equal(jobGlyph(mkJob({ status: "killed" })), "⊘");
    });
    void it("failed → ✗", () => {
        assert.equal(jobGlyph(mkJob({ status: "failed" })), "✗");
    });
});

void describe("statusTail", () => {
    void it("completed has no tail", () => {
        assert.equal(statusTail(mkJob({ status: "completed" })), "");
    });
    void it("killed says ', killed'", () => {
        assert.equal(statusTail(mkJob({ status: "killed" })), ", killed");
    });
    void it("failed with non-zero exit code says ', exit N'", () => {
        assert.equal(statusTail(mkJob({ status: "failed", exitCode: 1 })), ", exit 1");
    });
    void it("failed with no exit code says ', failed' (not exit 0)", () => {
        assert.equal(statusTail(mkJob({ status: "failed" })), ", failed");
    });
    void it("failed with exitCode 0 also says ', failed'", () => {
        assert.equal(statusTail(mkJob({ status: "failed", exitCode: 0 })), ", failed");
    });
});

void describe("statusLine", () => {
    void it("completed job: name, duration, id", () => {
        assert.match(
            statusLine(mkJob({ name: "tests", status: "completed" })),
            /^✓ tests \(5s, job-1-1\)$/
        );
    });
    void it("failed with exit code includes the code", () => {
        assert.match(
            statusLine(mkJob({ status: "failed", exitCode: 2 })),
            /^✗ "npm test" \(5s, exit 2, job-1-1\)$/
        );
    });
    void it("killed uses the kill glyph and tail", () => {
        assert.match(
            statusLine(mkJob({ status: "killed" })),
            /^⊘ "npm test" \(5s, killed, job-1-1\)$/
        );
    });
});

void describe("nudgeLine", () => {
    void it("returns null for completed jobs (bare status, nothing to act on)", () => {
        assert.equal(nudgeLine(mkJob({ id: "job-3-7", status: "completed" })), null);
    });
    void it("returns null for killed jobs (intentional cleanup, no nudge)", () => {
        assert.equal(nudgeLine(mkJob({ status: "killed" })), null);
    });
    void it("returns the jobs output nudge only for failed jobs", () => {
        assert.equal(
            nudgeLine(mkJob({ id: "job-3-7", status: "failed", exitCode: 1 })),
            '  → jobs({ action: "output", jobId: "job-3-7" })'
        );
    });
    void it("sanitizes stray quotes/newlines in the id (failed path)", () => {
        const out = nudgeLine(mkJob({ id: 'bad"id\n', status: "failed", exitCode: 1 }));
        assert.ok(out);
        assert.ok(!out.includes('"id\n'));
        assert.ok(out.includes('"bad?id?"'));
    });
});

void describe("jobNoticeLines", () => {
    void it("status only for a completed job (no nudge — Claude Code parity)", () => {
        const lines = jobNoticeLines(mkJob({ name: "tests" }));
        assert.equal(lines.length, 1);
        assert.match(lines[0], /^✓ tests/);
    });
    void it("status + nudge for a failed job", () => {
        const lines = jobNoticeLines(mkJob({ status: "failed", exitCode: 2 }));
        assert.equal(lines.length, 2);
        assert.match(lines[0], /^✗/);
        assert.match(lines[1], /jobs\(\{ action: "output"/);
    });
    void it("just status, no nudge, for a killed job", () => {
        const lines = jobNoticeLines(mkJob({ status: "killed" }));
        assert.equal(lines.length, 1);
        assert.match(lines[0], /^⊘/);
    });
});

void describe("formatMonitorLine", () => {
    void it("renders ◉ desc — summary", () => {
        const end: MonitorEnd = { description: "API health", summary: "stream ended", failed: false };
        assert.equal(formatMonitorLine(end), "◉ API health — stream ended");
    });
});

void describe("headline", () => {
    void it("0 + 0 is an empty string", () => {
        assert.equal(headline([], []), "");
    });
    void it("1 job, no failure", () => {
        assert.equal(headline([mkJob()], []), "1 background job finished");
    });
    void it("N jobs (N > 1) pluralizes and surfaces failed/killed", () => {
        const out = headline(
            [
                mkJob({ status: "completed" }),
                mkJob({ status: "failed", exitCode: 1 }),
                mkJob({ status: "killed" }),
            ],
            []
        );
        assert.equal(out, "3 background jobs finished (1 failed, 1 killed)");
    });
    void it("monitor failures surface in the monitor line", () => {
        const out = headline(
            [],
            [
                { description: "a", summary: "ok", failed: false },
                { description: "b", summary: "died", failed: true },
            ]
        );
        assert.equal(out, "2 monitors ended (1 failed)");
    });
    void it("jobs + monitors join with a period", () => {
        const out = headline(
            [mkJob({ status: "failed", exitCode: 1 })],
            [{ description: "x", summary: "ok", failed: false }]
        );
        assert.equal(
            out,
            "1 background job finished (1 failed). 1 monitor ended"
        );
    });
});

void describe("formatNotices", () => {
    void it("empty input returns an empty-string notice", () => {
        const n = formatNotices([], []);
        assert.equal(n, "");
    });
    void it("1 job + 1 monitor reports both — no silent drop", () => {
        const n = formatNotices(
            [mkJob({ id: "job-1-1" })],
            [{ description: "deploy", summary: "stream ended", failed: false }]
        );
        assert.match(n, /1 background job finished\. 1 monitor ended/);
        assert.match(n, /✓ "npm test" \(5s, job-1-1\)/);
        assert.match(n, /◉ deploy — stream ended/);
    });
    void it("failed jobs are listed before completed ones", () => {
        const n = formatNotices(
            [
                mkJob({ id: "ok-1", status: "completed" }),
                mkJob({ id: "bad-1", status: "failed", exitCode: 1 }),
            ],
            []
        );
        const lines = n.split("\n");
        const failedIdx = lines.findIndex((l) => l.includes("bad-1"));
        const okIdx = lines.findIndex((l) => l.includes("ok-1"));
        assert.ok(failedIdx < okIdx);
    });
    void it("kills get the ⊘ glyph and no nudge line", () => {
        const n = formatNotices(
            [
                mkJob({ id: "ok-1", status: "completed" }),
                mkJob({ id: "k-1", status: "killed" }),
            ],
            []
        );
        assert.match(n, /^⊘ "npm test" \(5s, killed, k-1\)$/m);
        // The k-1 line is alone (no nudge under it), so it has no follow-up line.
        const lines = n.split("\n");
        const kIdx = lines.findIndex((l) => l.includes("k-1"));
        const next = lines[kIdx + 1] ?? "";
        assert.ok(!next.includes("jobs({ action:"), `unexpected nudge under killed: ${next}`);
    });
});

/**
 * Unit tests for the formatting helpers.
 */

import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import {
    formatDuration,
    formatJobLine,
    statusLabel,
    truncateTail,
} from "../format.ts";
import type { Job } from "../types.ts";

function makeJob(overrides: Partial<Job> = {}): Job {
    return {
        id: "job-test-1",
        command: "echo",
        pid: 1,
        startTime: Date.now(),
        status: "completed",
        logPath: "/tmp/test",
        toolCallId: "tc-1",
        isBackgrounded: false,
        ...overrides,
    };
}

void describe("formatDuration", () => {
    void it("sub-second rounds to 0s", () => {
        assert.equal(formatDuration(0), "0s");
        assert.equal(formatDuration(999), "0s");
    });
    void it("seconds only", () => {
        assert.equal(formatDuration(1_000), "1s");
        assert.equal(formatDuration(45_000), "45s");
    });
    void it("minutes + seconds", () => {
        assert.equal(formatDuration(60_000), "1m0s");
        assert.equal(formatDuration(125_000), "2m5s");
        assert.equal(formatDuration(3_600_000), "1h0m");
        assert.equal(formatDuration(6_000_000), "1h40m"); // 100m → keeps the column short
    });
});

void describe("truncateTail", () => {
    void it("returns as-is when within maxChars", () => {
        assert.equal(truncateTail("short", 100), "short");
    });
    void it("adds marker + tail when over maxChars", () => {
        const out = truncateTail("x".repeat(200), 50);
        assert.match(out, /\.\.\.\[truncated, showing last 50 chars\]/);
        assert.ok(out.endsWith("x".repeat(50)));
    });
});

void describe("statusLabel", () => {
    void it("running + backgrounded", () => {
        assert.equal(
            statusLabel(makeJob({ status: "running", isBackgrounded: true })),
            "▶ bg (0s)"
        );
    });
    void it("running + foreground", () => {
        assert.equal(
            statusLabel(makeJob({ status: "running", isBackgrounded: false })),
            "▶ fg (0s)"
        );
    });
    void it("completed", () => {
        assert.equal(statusLabel(makeJob({ status: "completed" })), "✓ completed");
    });
    void it("failed", () => {
        assert.equal(statusLabel(makeJob({ status: "failed" })), "✗ failed");
    });
    void it("killed", () => {
        assert.equal(statusLabel(makeJob({ status: "killed" })), "✗ killed");
    });
});

test("statusLabel distinguishes foreground and background", () => {
    const base = { id: "j1", command: "ls", pid: 1, startTime: Date.now(), logPath: "/tmp/x", toolCallId: "t1" };
    const fg = { ...base, status: "running" as const, isBackgrounded: false };
    const bg = { ...base, status: "running" as const, isBackgrounded: true };
    assert.ok(statusLabel(fg).includes("fg"));
    assert.ok(statusLabel(bg).includes("bg"));
});

void describe("formatJobLine", () => {
    void it("running jobs show duration", () => {
        const job: Job = {
            id: "job-1-1",
            command: "sleep 60",
            pid: 1,
            startTime: Date.now() - 5_000,
            status: "running",
            logPath: "/tmp/test",
            toolCallId: "tc-1",
            isBackgrounded: true,
        };
        assert.match(formatJobLine(job), /^job-1-1: sleep 60 - ▶ bg \(5s\) \(5s\)$/);
    });
    void it("named jobs show the name first", () => {
        const job: Job = {
            id: "job-1-2",
            name: "build",
            command: "ls",
            pid: 1,
            startTime: Date.now(),
            status: "completed",
            logPath: "/tmp/test",
            toolCallId: "tc-1",
            isBackgrounded: false,
        };
        assert.match(formatJobLine(job), /^build \(job-1-2\):/);
    });
});

// src/__tests__/task-monitor.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { TaskMonitor } from "../task-monitor.ts";
import type { Job } from "../types.ts";

// Emit real SGR so the component's ANSI-strip based selected-row detection works
// exactly as it does with pi's Theme.
const theme = {
    fg: (_c: string, t: string) => `\x1b[38;5;1m${t}\x1b[0m`,
    bg: (_s: string, t: string) => `\x1b[48;5;1m${t}\x1b[0m`,
    bold: (t: string) => `\x1b[1m${t}\x1b[0m`,
};

function job(over: Partial<Job>): Job {
    return {
        id: "job-1-1",
        command: "cargo build --release",
        pid: 123,
        startTime: Date.now() - 60_000,
        status: "running",
        logPath: "/tmp/nope.log",
        toolCallId: "t1",
        isBackgrounded: true,
        ...over,
    } as Job;
}

function makeReg(jobs: Job[]) {
    return { jobs: new Map(jobs.map((j) => [j.id, j])) } as never;
}

const ctx = { mode: "tui", ui: { theme, notify: () => {} } } as never;

describe("TaskMonitor", () => {
    test("renders a two-pane frame with the title and filter tabs", () => {
        const m = new TaskMonitor(
            makeReg([job({}), job({ id: "job-1-2", status: "completed" })]),
            ctx,
            theme as never,
            () => {},
            () => {},
            "all"
        );
        const lines = m.render(100);
        const text = lines.join("\n");
        assert.ok(lines.length > 3);
        assert.ok(text.includes("Task Monitor"));
        assert.ok(text.includes("[all]"));
        assert.ok(lines.some((l) => l.includes("│"))); // pane divider
    });

    test("filter keys narrow the list; enter moves focus to output; esc closes", () => {
        const running = job({ id: "job-1-a" });
        const done = job({ id: "job-1-b", status: "completed" });
        let closed = false;
        const m = new TaskMonitor(makeReg([running, done]), ctx, theme as never, () => {}, () => (closed = true), "all");

        m.handleInput("2"); // filter -> running
        m.render(100);
        assert.ok(!m.render(100).join("\n").includes("job-1-b"));
        // Selected running job's output header is shown in the right pane.
        assert.ok(m.render(100).join("\n").includes("cargo build --release"));

        m.handleInput("\r"); // enter -> focus output
        m.handleInput("j"); // scroll output
        m.handleInput("\x1b"); // esc -> back to list
        m.handleInput("q"); // q -> close
        assert.equal(closed, true);
    });
});

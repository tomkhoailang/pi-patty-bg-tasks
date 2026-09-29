// src/__tests__/task-monitor.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskMonitor } from "../task-monitor.ts";
import type { Job } from "../types.ts";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";

const mouse = (type: TuiMouseEvent["type"], x: number, y: number): TuiMouseEvent => ({
    type, button: "left", x, y, screenX: x, screenY: y,
    width: 100, height: 30, shift: false, alt: false, ctrl: false,
});

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

    test("filter keys narrow the list; typing searches; esc closes", () => {
        const running = job({ id: "job-1-a" });
        const done = job({ id: "job-1-b", status: "completed" });
        let closed = false;
        const m = new TaskMonitor(makeReg([running, done]), ctx, theme as never, () => {}, () => (closed = true), "all");

        m.handleInput("2"); // filter -> running
        m.render(100);
        assert.ok(!m.render(100).join("\n").includes("job-1-b"));
        // Selected running job's output header is shown in the right pane.
        assert.ok(m.render(100).join("\n").includes("cargo build --release"));

        m.handleInput("q"); // a search char — must NOT close
        assert.equal(closed, false);
        // There is no focus mode: Enter no longer switches panes, and `esc` is
        // the only close.
        m.handleInput("\r");
        assert.equal(closed, false);
        m.handleInput("\x1b");
        assert.equal(closed, true);
    });

    test("mouse click selects the row under the pointer (frame offset)", () => {
        const reg = makeReg([
            job({ id: "job-1-1", name: "one", status: "running" }),
            job({ id: "job-1-2", name: "two", status: "completed" }),
        ]);
        const m = new TaskMonitor(reg, ctx, theme as never, () => {}, () => {}, "all");
        m.render(100);
        // Body row 1 is at overall y=7 (border + title + action + blank + search + blank + row0).
        m.handleMouse({
            type: "click", button: "left", x: 3, y: 7, screenX: 3, screenY: 7,
            width: 100, height: 30, shift: false, alt: false, ctrl: false,
        });
        const lines = m.render(100).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
        const sel = lines.find((l) => l.includes("→"));
        assert.ok(sel && sel.includes("two"), sel ?? "(no selected row)");
    });

    test("search is fuzzy, not substring", () => {
        const reg = makeReg([
            job({ id: "job-1-1", name: "cargo build", command: "cargo build" }),
            job({ id: "job-1-2", name: "deploy web", command: "deploy web" }),
        ]);
        const m = new TaskMonitor(reg, ctx, theme as never, () => {}, () => {}, "all");
        // `rgo` is NOT a substring of "cargo build" — it only matches as a
        // subsequence. (Query chars must avoid x/c/d: those are the action keys.)
        for (const ch of "rgo") m.handleInput(ch);
        const text = m
            .render(100)
            .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
            .join("\n");
        assert.ok(text.includes("cargo build"), "subsequence match survives");
        assert.ok(!text.includes("deploy web"), "non-match stays hidden");
    });

    test("the title-bar close button is clickable", () => {
        let closed = false;
        const m = new TaskMonitor(makeReg([job({})]), ctx, theme as never, () => {}, () => (closed = true), "all");
        const lines = m.render(100).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
        // Line 1 is the title bar; the close button is pinned to its right edge.
        const title = lines[1]!;
        const x = title.indexOf("esc ✕");
        assert.ok(x > 0, `close button on the title bar: ${title}`);
        assert.ok(!lines.some((l) => l.includes("esc close")), "no longer in the footer bar");

        m.handleMouse({
            type: "click", button: "left", x, y: 1,
            screenX: 0, screenY: 0, width: 100, height: 30, shift: false, alt: false, ctrl: false,
        });
        assert.equal(closed, true);
    });

    test("filter tabs are clickable", () => {
        const reg = makeReg([
            job({ id: "job-1-1", name: "live", command: "aaa", status: "running" }),
            job({ id: "job-1-2", name: "donejob", command: "zzzcomplete", status: "completed" }),
        ]);
        const m = new TaskMonitor(reg, ctx, theme as never, () => {}, () => {}, "all");
        const stripAnsi = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");
        const line = m.render(100).map(stripAnsi).find((l) => l.includes("Search:"))!;
        const x = line.indexOf(" running ");
        m.handleMouse({
            type: "click", button: "left", x, y: 5, screenX: x, screenY: 5,
            width: 100, height: 30, shift: false, alt: false, ctrl: false,
        });
        assert.ok(!m.render(100).map(stripAnsi).join("\n").includes("zzzcomplete"), "completed job hidden under running filter");
    });

    test("Home/End scroll the output without focusing it; a scrollbar is drawn", () => {
        const log = join(tmpdir(), `tm-scroll-${process.pid}.log`);
        writeFileSync(log, Array.from({ length: 40 }, (_, i) => `L${String(i).padStart(2, "0")}`).join("\n") + "\n");
        const reg = makeReg([job({ id: "job-1-1", name: "long", logPath: log })]);
        const m = new TaskMonitor(reg, ctx, theme as never, () => {}, () => {}, "all");
        const stripAnsi = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");
        try {
            assert.ok(m.render(100).map(stripAnsi).join("\n").includes("┃"), "scrollbar thumb rendered");
            m.handleInput("\x1b[H"); // Home, list still focused
            const home = m.render(100).map(stripAnsi).join("\n");
            assert.ok(home.includes("L00"), "Home jumped to the top of the log");
            m.handleInput("\x1b[F"); // End
            const end = m.render(100).map(stripAnsi).join("\n");
            assert.ok(!end.includes("L00"), "End jumped back to the bottom");
        } finally {
            unlinkSync(log);
        }
    });

    test("scrollbar drag lands where the pointer is", () => {
        const log = join(tmpdir(), `tm-sb-${process.pid}.log`);
        writeFileSync(log, Array.from({ length: 40 }, (_, i) => `L${String(i).padStart(2, "0")}`).join("\n") + "\n");
        const reg = makeReg([job({ id: "job-1-1", name: "long", logPath: log })]);
        const m = new TaskMonitor(reg, ctx, theme as never, () => {}, () => {}, "all");
        const stripAnsi = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");
        const at = (x: number, y: number): TuiMouseEvent => mouse("press", x, y);
        try {
            m.render(100);
            // Top log row is y=9, bottom (LOG_ROWS-1) is y=27; scrollbar column x=98.
            m.handleMouse(at(98, 9));
            assert.ok(m.render(100).map(stripAnsi).join("\n").includes("L00"), "drag to top shows the first line");
            m.handleMouse(at(98, 27));
            m.handleMouse({ ...at(98, 27), type: "drag" });            assert.ok(m.render(100).map(stripAnsi).join("\n").includes("L39"), "drag to bottom shows the last line");
            m.handleMouse({ ...at(98, 27), type: "release" });
        } finally {
            unlinkSync(log);
        }
    });
});

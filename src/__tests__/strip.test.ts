// src/__tests__/strip.test.ts
//
// The strip is the task list above the editor. Three behaviours are load-bearing
// and easy to regress: finished jobs never appear, `esc` is the ONLY cancel, and
// the footer's monitor button opens the modal.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundRegistry } from "../state.ts";
import { createStripWidget } from "../strip.ts";
import { renderSidebar } from "../registry.ts";
import type { Job, StripActions, StripRow, StripTheme, StripWidgetComponent } from "../types.ts";

const theme: StripTheme = { fg: (_c: string, t: string) => t };
const tui = { requestRender: () => {} };

function job(over: Partial<Job>): Job {
    return {
        id: "job-9-1",
        command: "cargo build",
        pid: 4242,
        startTime: 1,
        status: "running",
        logPath: "/tmp/pi-bg/does-not-exist.log",
        toolCallId: "t1",
        isBackgrounded: true,
        ...over,
    } as Job;
}

function actions(over: Partial<StripActions> = {}): StripActions {
    return {
        select: () => {},
        expand: () => {},
        toggleList: () => {},
        kill: () => {},
        openMonitor: () => {},
        expandedJobId: () => undefined,
        listExpanded: () => false,
        detail: () => ["cargo build · running · 1s"],
        ...over,
    };
}

const row = (): StripRow =>
    ({
        kind: "job",
        job: job({}),
        state: "running",
        name: "cargo build",
        detail: ": compiling",
        elapsed: "0m12s",
    }) as StripRow;

function comp(rows: StripRow[], acts: StripActions): StripWidgetComponent {
    const factory = createStripWidget(() => rows, theme, acts, () => {}, () => {});
    return factory(tui, theme);
}

/** Install through renderSidebar and hand back the live component. */
function installStrip(reg: BackgroundRegistry): StripWidgetComponent {
    let factory: unknown;
    const ctx = {
        mode: "tui",
        ui: {
            theme,
            setWidget: (_name: string, widget: unknown) => { factory = widget; },
            setStatus: () => {},
        },
    };
    renderSidebar(reg, ctx as never);
    assert.equal(typeof factory, "function", "widget installed");
    return (factory as (t: unknown, th: StripTheme) => StripWidgetComponent)(tui, theme);
}

describe("strip", () => {
    test("finished jobs are never rows", () => {
        const reg = new BackgroundRegistry();
        reg.jobs.set("job-9-1", job({ id: "job-9-1", status: "completed" }));
        reg.jobs.set("job-9-2", job({ id: "job-9-2", status: "killed" }));
        reg.jobs.set("job-9-3", job({ id: "job-9-3", status: "running" }));

        const lines = installStrip(reg).render(100);
        assert.equal(lines.length, 2, "one grid line + footer");
        assert.ok(lines[0]!.includes("cargo build"), "the running job is shown");
        assert.ok(lines[1]!.includes("⌗ monitor"), "footer carries the monitor button");
    });

    test("with nothing to show only the monitor button remains", () => {
        const reg = new BackgroundRegistry();
        const lines = installStrip(reg).render(100);
        assert.equal(lines.length, 1);
        assert.ok(lines[0]!.includes("⌗ monitor"));
    });

    test("esc collapses; q is left to the editor", () => {
        const calls: string[] = [];
        const acts = actions({
            expandedJobId: () => "job-9-1",
            expand: (id) => calls.push(`expand:${id}`),
        });
        const c = comp([row()], acts);

        assert.equal(c.handleKey!("q"), false, "q is NOT swallowed");
        assert.deepEqual(calls, []);
        assert.equal(c.handleKey!("\x1b"), true, "esc is ours");
        assert.deepEqual(calls, ["expand:undefined"]);
    });

    test("with nothing expanded no key is swallowed, so a modal keeps esc", () => {
        // This is what makes `o monitor` closeable: opening the modal clears the
        // expansion, handleKey() bails on its first line, and the focused overlay
        // receives the key instead of the strip eating it.
        const c = comp([row()], actions({ expandedJobId: () => undefined }));
        assert.equal(c.handleKey!("\x1b"), false);
        assert.equal(c.handleKey!("x"), false);
        assert.equal(c.handleKey!("o"), false);
    });

    test("clicking the footer opens the task monitor", () => {
        const calls: string[] = [];
        const c = comp([row()], actions({ openMonitor: () => calls.push("monitor") }));
        const lines = c.render(100);
        const footerY = lines.length - 1;
        const x = lines[footerY]!.indexOf("⌗ monitor");

        c.handleMouse!({ type: "click", button: "left", x, y: footerY });
        assert.deepEqual(calls, ["monitor"]);

        // Hover must only repaint, never act.
        c.handleMouse!({ type: "move", button: "left", x, y: footerY });
        assert.deepEqual(calls, ["monitor"]);
    });
});

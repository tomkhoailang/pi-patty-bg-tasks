// src/__tests__/contract.test.ts
//
// The background-task contract is prompt surface, and it lives in the TOOL
// DESCRIPTIONS — read once — not in tool results, read on every call. §10.5 of
// docs/antigravity-background-tasks.md records Antigravity's own changelog: the
// anti-poll reminder they put in `manage_task` results "could itself nudge the
// model into a polling loop". These assertions pin the wording so it cannot
// silently drift back into results.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerBashTool } from "../tools/bash.ts";
import { registerBashBgTool } from "../tools/bash-bg.ts";
import { registerJobsTool } from "../tools/jobs.ts";
import { registerJobDecideTool } from "../tools/job-decide.ts";

interface Def {
    name: string;
    description: string;
    promptGuidelines?: string[];
}

function defs(): Map<string, Def> {
    const tools = new Map<string, Def>();
    const pi = { registerTool: (d: Def) => tools.set(d.name, d) } as never;
    const reg = {} as never;
    registerBashTool(pi, reg, undefined as never);
    registerBashBgTool(pi, reg);
    registerJobsTool(pi, reg);
    registerJobDecideTool(pi, reg);
    return tools;
}

const text = (d: Def | undefined) => `${d?.description ?? ""}\n${(d?.promptGuidelines ?? []).join("\n")}`;

describe("the A/B contract", () => {
    test("bash and bash_bg both state the two allowed actions", () => {
        const t = defs();
        for (const name of ["bash", "bash_bg"]) {
            assert.match(text(t.get(name)), /take one of exactly two actions/, name);
            assert.match(text(t.get(name)), /no polling/i, name);
        }
    });

    test("bash_bg promises the wake and forbids reading the log file", () => {
        const t = text(defs().get("bash_bg"));
        assert.match(t, /you are resumed when the job completes/, "wake promise");
        assert.match(t, /Never read the log file/, "log-file ban");
    });

    test("jobs says waiting is not the agent's job", () => {
        const t = text(defs().get("jobs"));
        assert.match(t, /never read the log files/, "log-file ban");
        assert.match(t, /Waiting is not your job/, "no polling to wait");
        assert.match(t, /ON DEMAND/, "output is a read, not a wait");
    });

    test("job_decide explains that keep silences the episode", () => {
        assert.match(text(defs().get("job_decide")), /stop asking about this silence episode/);
    });

    test("bash runs a synchronous command when the next step needs its result", () => {
        assert.match(text(defs().get("bash")), /run it synchronously/);
    });
});

describe("results stay free of instructions", () => {
    test("the background hand-off result carries facts only", () => {
        // Source-level guard: driving the 15s auto-background path in a unit test
        // would cost 15 real seconds. The hand-off text must stay a fact list —
        // no "attach", no "do NOT poll".
        const src = readFileSync(new URL("../tools/bash.ts", import.meta.url), "utf8");
        const handoff = src.slice(src.indexOf("if (race.kind === \"backgrounded\")"));
        const block = handoff.slice(0, handoff.indexOf("details: undefined"));
        assert.match(block, /Process backgrounded as/, "still reports what happened");
        assert.doesNotMatch(block, /Do NOT poll/, "no instruction in the result");
        assert.doesNotMatch(block, /jobs\(\{ action: "attach"/, "no instruction in the result");
    });
});

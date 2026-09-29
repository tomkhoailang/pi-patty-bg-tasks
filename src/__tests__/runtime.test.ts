// src/__tests__/runtime.test.ts
//
// The crash-safe job record + startup reaper (see runtime.ts). These paths only
// matter when pi died without a session_shutdown, so they get a REAL spawned
// process group to prove the reaper kills and prunes.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
    RUNTIME_FILE,
    clearRuntimeJob,
    reapOrphanProcessGroup,
    reapRuntimeOrphans,
    recordRuntimeJob,
} from "../runtime.ts";
import type { Job } from "../types.ts";

const job = (over: Partial<Job>): Job =>
    ({
        id: "job-1-1",
        command: "sleep 30",
        pid: 0,
        startTime: 1,
        status: "running",
        logPath: "/tmp/pi-bg/x.log",
        toolCallId: "t1",
        isBackgrounded: true,
        ...over,
    }) as Job;

const entries = (): Record<string, { ownerPid: number; pid: number }> => {
    try {
        return JSON.parse(readFileSync(RUNTIME_FILE, "utf8")).jobs;
    } catch {
        return {};
    }
};

/** A detached child in its own process group, like a background job. */
const spawnGroup = (): { pid: number; kill: () => void } => {
    const child = spawn("bash", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    return {
        pid: child.pid!,
        kill: () => {
            try {
                process.kill(-child.pid!, "SIGKILL");
            } catch {
                /* already gone */
            }
        },
    };
};

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

describe("runtime record", () => {
    test("records a spawn and clears it when terminal", () => {
        rmSync(RUNTIME_FILE, { force: true });
        recordRuntimeJob(job({ id: "job-rec-1", pid: 4321 }));
        assert.equal(entries()["job-rec-1"]?.pid, 4321);
        clearRuntimeJob("job-rec-1");
        assert.equal(entries()["job-rec-1"], undefined);
    });

    test("a ws monitor (pid 0) is never recorded", () => {
        rmSync(RUNTIME_FILE, { force: true });
        recordRuntimeJob(job({ id: "job-rec-2", pid: 0 }));
        assert.equal(entries()["job-rec-2"], undefined);
    });
});

describe("reaper", () => {
    test("prunes dead records and leaves this process's jobs alone", () => {
        rmSync(RUNTIME_FILE, { force: true });
        recordRuntimeJob(job({ id: "job-mine", pid: process.pid }));
        recordRuntimeJob(job({ id: "job-dead", pid: 0x7ffffffe }));
        // Re-label as another pi's: only a FOREIGN owner makes it a reap target.
        const file = JSON.parse(readFileSync(RUNTIME_FILE, "utf8"));
        file.jobs["job-dead"].ownerPid = process.pid + 1;
        writeFileSync(RUNTIME_FILE, JSON.stringify(file));

        reapRuntimeOrphans();
        assert.ok(entries()["job-mine"], "own job kept (survives /reload)");
        assert.equal(entries()["job-dead"], undefined, "dead foreign record pruned");
    });

    test("pid-reuse guard: a non-shell group leader is left running", (t) => {
        if (process.platform !== "linux") return t.skip("Linux-only reap");
        reapOrphanProcessGroup(process.pid); // node, not bash/sh/script
        assert.ok(alive(process.pid), "unrelated process untouched");
    });

    test("reaps a foreign pi's orphan group", async (t) => {
        if (process.platform !== "linux") return t.skip("Linux-only reap");
        rmSync(RUNTIME_FILE, { force: true });
        const child = spawnGroup();
        try {
            recordRuntimeJob(job({ id: "job-orphan", pid: child.pid }));
            // Re-label it as another pi's — owner !== us is what marks an orphan.
            const file = JSON.parse(readFileSync(RUNTIME_FILE, "utf8"));
            file.jobs["job-orphan"].ownerPid = process.pid + 1;
            writeFileSync(RUNTIME_FILE, JSON.stringify(file));

            reapRuntimeOrphans();
            const deadline = Date.now() + 2000;
            while (alive(child.pid) && Date.now() < deadline) await delay(20);

            assert.equal(alive(child.pid), false, "orphan group was SIGTERMed");
            assert.equal(entries()["job-orphan"], undefined, "record pruned");
        } finally {
            child.kill();
        }
    });
});

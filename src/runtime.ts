/**
 * Crash-safe runtime record of live jobs.
 *
 * `session_shutdown` covers every graceful exit — Ctrl+C / Ctrl+D / `/quit`,
 * SIGTERM, SIGHUP, reload — and it appends a job snapshot for the next start to
 * restore. But a SIGKILL, a power loss, or pi's own emergency exits (dead
 * terminal, uncaught exception) run no extension code at all. The detached child
 * keeps running and, with pi gone, nothing enforces the 100 MiB log cap.
 *
 * This file is the record those exits still leave behind. It is written the
 * moment a job spawns, cleared when it becomes terminal, and read on the next
 * `session_start` to reap any group whose owner pi is gone.
 *
 * Lives beside the logs so one directory holds everything the extension owns.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { killProcessTree, processExists } from "./spawn.ts";
import type { Job } from "./types.ts";

/** Dedicated log directory. Keeping logs in their own dir (not loose in /tmp)
 *  keeps the stale-log sweep bounded — it lists only our files. */
export const LOG_DIR = "/tmp/pi-bg";

/** Crash-safe job record. Beside the logs, so one sweep covers both. */
export const RUNTIME_FILE = pathJoin(LOG_DIR, "jobs.json");

interface RuntimeRecord {
    id: string;
    /** The pi process that spawned the job. A DIFFERENT value means that pi is
     *  gone (or this is a new one) and its jobs are orphans to reap. */
    ownerPid: number;
    /** Process-group leader pid (jobs are spawned detached). */
    pid: number;
    logPath: string;
    startedAt: number;
}

interface RuntimeFile {
    schema: 1;
    jobs: Record<string, RuntimeRecord>;
}

function read(): RuntimeFile {
    try {
        const parsed = JSON.parse(readFileSync(RUNTIME_FILE, "utf8")) as RuntimeFile;
        if (parsed && parsed.jobs && typeof parsed.jobs === "object") return parsed;
    } catch {
        /* missing or torn — start clean */
    }
    return { schema: 1, jobs: {} };
}

/** Atomic replace: a SIGKILL mid-write cannot leave a torn file for the reaper. */
function write(file: RuntimeFile): void {
    try {
        mkdirSync(LOG_DIR, { recursive: true });
        const tmp = `${RUNTIME_FILE}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(file));
        renameSync(tmp, RUNTIME_FILE);
    } catch {
        /* best effort: the session snapshot still covers graceful exits */
    }
}

/** Record a job the moment it spawns. Cheap — one small write per job start. */
export function recordRuntimeJob(job: Job): void {
    if (!job.pid || job.pid <= 0) return; // a ws monitor has no process
    const file = read();
    file.jobs[job.id] = {
        id: job.id,
        ownerPid: process.pid,
        pid: job.pid,
        logPath: job.logPath,
        startedAt: job.startTime,
    };
    write(file);
}

/** Drop a job's record once it is terminal (or forgotten). */
export function clearRuntimeJob(id: string): void {
    const file = read();
    if (!(id in file.jobs)) return;
    delete file.jobs[id];
    write(file);
}

/**
 * Best-effort reap of a process group left behind by a PREVIOUS pi process
 * (crash / SIGKILL / terminal close). Guarded so we never signal an unrelated
 * process: Linux only, and only when the group leader's cmdline still looks like
 * one of our shells/runners (pid-reuse guard).
 */
export function reapOrphanProcessGroup(pid: number): void {
    if (process.platform !== "linux") return;
    let cmdline: string;
    try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    } catch {
        return; // /proc entry gone — already exited
    }
    if (!/\b(bash|sh|script)\b/.test(cmdline)) return;
    killProcessTree(pid, "SIGTERM");
}

/**
 * Reap every group recorded by a previous pi, and prune dead records.
 *
 * Called on `session_start`. Records owned by THIS process are left alone: after
 * a `/reload` the same pid keeps its jobs, and the restored snapshot is what
 * tracks them.
 */
export function reapRuntimeOrphans(): void {
    const file = read();
    let changed = false;
    for (const [id, rec] of Object.entries(file.jobs)) {
        if (rec.ownerPid === process.pid) continue;
        if (processExists(rec.pid)) reapOrphanProcessGroup(rec.pid);
        delete file.jobs[id];
        changed = true;
    }
    if (changed) write(file);
}

// src/__tests__/silence.test.ts
//
// The rule that makes background jobs liveable (§8 Q1): *silence is not an
// event*. Nothing is pushed because a job stopped talking; only two EDGES speak,
// once per episode — a prompt-like tail (the job is blocked and its stdin is
// /dev/null, so it can never be answered) and silence past the long threshold.
// Fresh output re-arms, and `job_decide keep` mutes the episode.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { watchStalls } from "../monitoring.ts";
import type { Job } from "../types.ts";

const QUIET = 30;
const LONG = 90;

function harness(tail: string) {
    const dir = mkdtempSync(join(tmpdir(), "silence-"));
    const logPath = join(dir, "job.log");
    writeFileSync(logPath, tail);
    const messages: string[] = [];
    const pi = { sendMessage: (m: { content: string }) => messages.push(m.content) };
    const job = { id: "job-9-1", command: "npm test", quietSilenced: false } as unknown as Job;
    const cancel = watchStalls({
        jobId: job.id,
        command: job.command,
        logPath,
        pi: pi as never,
        job,
        quietMs: QUIET,
        quietLongMs: LONG,
        intervalMs: 15,
    });
    return {
        messages,
        job,
        logPath,
        stop: () => {
            cancel();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

describe("silence is not an event", () => {
    test("a quiet job says nothing until the long threshold, then once", async () => {
        const h = harness("starting\n");
        try {
            await delay(QUIET + 20); // past the soft threshold
            assert.equal(h.messages.length, 0, "soft silence stays silent");

            await delay(LONG + 60); // past the long threshold
            assert.equal(h.messages.length, 1, "one decision at the long threshold");
            assert.match(h.messages[0]!, /has been quiet for/);
            assert.match(h.messages[0]!, /job_decide job-9-1 keep\|kill\|check/);
            assert.equal(h.job.quietSilenced, true, "episode recorded on the job");

            await delay(LONG + 40);
            assert.equal(h.messages.length, 1, "and it does not repeat");
        } finally {
            h.stop();
        }
    });

    test("fresh output re-arms the episode", async () => {
        const h = harness("starting\n");
        try {
            await delay(LONG + 60);
            assert.equal(h.messages.length, 1);

            appendFileSync(h.logPath, "still working\n"); // a heartbeat
            await delay(QUIET + 20);
            assert.equal(h.job.quietSilenced, false, "growth cleared the episode");

            await delay(LONG + 60);
            assert.equal(h.messages.length, 2, "the NEW silence is its own episode");
        } finally {
            h.stop();
        }
    });

    test("a muted episode stays muted (`job_decide keep`)", async () => {
        const h = harness("starting\n");
        try {
            // Let the watcher absorb the initial content first: that first read
            // counts as output and would legitimately clear the mute.
            await delay(40);
            h.job.quietSilenced = true; // the agent answered keep
            await delay(LONG + 80);
            assert.equal(h.messages.length, 0, "keep silences this episode");
        } finally {
            h.stop();
        }
    });

    test("a prompt-like tail is reported early, as blocked-on-input", async () => {
        const h = harness("Overwrite existing file? (y/n)");
        try {
            await delay(QUIET + 40); // only the SOFT threshold, no long wait
            assert.equal(h.messages.length, 1, "actionable state, reported at once");
            assert.match(h.messages[0]!, /blocked on input/);
            assert.match(h.messages[0]!, /stdin is \/dev\/null/);
        } finally {
            h.stop();
        }
    });
});

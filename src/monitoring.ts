/**
 * Activity-based quiet detection for background jobs.
 *
 * Watches a job's log file and, when a *running* job goes quiet, decides whether
 * that is worth saying out loud. Per docs/antigravity-background-tasks.md §8/§10,
 * the answer is almost always no:
 *
 *   - **Silence is not an event.** Nothing is pushed while a job is merely quiet
 *     — a long link step, a dev server, a blocked read all look identical, and
 *     neither Claude Code nor Antigravity notifies on silence at all.
 *   - **Two edges do speak**, once per episode: silence that reaches
 *     QUIET_LONG_MS (the "is this thing stuck?" question), and silence whose tail
 *     looks like an interactive prompt (the `requires_action` case — actionable
 *     right now, because stdin is /dev/null and it can never be answered).
 *   - **Silence never kills.** Only the MAX_LOG_BYTES oversize guard terminates.
 *   - **Fresh output re-arms everything**, so a heartbeat is a new episode, not a
 *     repeat of the old one.
 *
 * Progress streaming lives in output.ts (pollFileTail).
 */

import { openSync, readSync, closeSync, statSync as fsStatSync } from "node:fs";
import { setTimeout as nodeSetTimeout } from "node:timers";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    DELIVER_FOLLOWUP,
    DELIVER_STEER,
    EVENT,
    MAX_LOG_BYTES,
    QUIET_LONG_MS,
    QUIET_MS,
    STALL_CHECK_INTERVAL_MS,
    STALL_TAIL_BYTES,
    type Delivery,
    type Job,
} from "./types.ts";
import { policyAllowsDecision } from "./notify-policy.ts";


/**
 * Watch a running job for output silence. When the log file:
 *   1. exceeds MAX_LOG_BYTES, call onOversize and report the job terminated;
 *   2. stops growing for QUIET_MS, send one "no output for Ns" notice;
 *   3. stays quiet for QUIET_LONG_MS, escalate to a keep/kill/check prompt.
 *
 * A quiet episode ends (and its notices re-arm) the moment the log grows again.
 * Callers MUST invoke the returned cancel on completion to clear the interval.
 */
export function watchStalls(args: {
    jobId: string;
    command: string;
    logPath: string;
    pi: ExtensionAPI;
    /** The registry job, when available: lets the watcher record that this
     *  silence episode has been reported (`quietSilenced`) instead of keeping
     *  that state privately, so `job_decide keep` can mute the same episode. */
    job?: Job;
    onOversize?: () => void;
    /** Skip the quiet watch (used for monitors, which stream their own events,
     *  so a quiet tail is normal rather than a stall). */
    disableQuietWatch?: boolean;    /** Skip the oversize auto-kill (used for persistent monitors). */
    disableOversizeKill?: boolean;
    /** Called on every tick where the job is quiet, so callers can mark it in
     *  the UI (the strip shows a warning row). Purely local: no message. */
    onQuiet?: () => void;
    /** Delivery for the two messages this watcher may send (oversize notice,
     *  decision event). Supplied by the caller, which knows whether the agent is
     *  mid-turn — mid-turn injection needs no turn of its own. Defaults to the
     *  passive follow-up. */
    deliver?: () => Delivery;
    /** Threshold overrides, in ms. Defaults to QUIET_MS / QUIET_LONG_MS; tests
     *  drive the window instead of waiting a minute. */
    quietMs?: number;
    quietLongMs?: number;
    /** Tick interval override (defaults to STALL_CHECK_INTERVAL_MS). */
    intervalMs?: number;
}): () => void {
    let lastSize = 0;
    let lastGrowth = Date.now();
    let cancelled = false;
    const quietMs = args.quietMs ?? QUIET_MS;
    const quietLongMs = args.quietLongMs ?? QUIET_LONG_MS;

    const timer = nodeSetTimeout(function tick() {
        if (cancelled) return;
        try {
            const { size } = fsStatSync(args.logPath);

            if (size > MAX_LOG_BYTES && !args.disableOversizeKill) {
                cancelled = true;
                args.onOversize?.();
                args.pi.sendMessage(
                    {
                        customType: EVENT.stall,
                        content: `Background job ${args.jobId} exceeded ${MAX_LOG_BYTES / (1024 * 1024)} MiB of output and was terminated.`,
                        display: true,
                        details: { jobId: args.jobId, logPath: args.logPath, command: args.command },
                    },
                    args.deliver?.() ?? DELIVER_FOLLOWUP
                );
                return;
            }

            if (size > lastSize) {
                // Producing: the quiet episode is over. Fresh output re-arms the
                // watch, so the NEXT silence is a new decision, not a repeat.
                lastSize = size;
                lastGrowth = Date.now();
                if (args.job) args.job.quietSilenced = false;
                timer.refresh();
                return;
            }

            if (args.disableQuietWatch) {
                timer.refresh();
                return;
            }

            const quietFor = Date.now() - lastGrowth;
            if (quietFor >= quietMs) args.onQuiet?.();

            // One decision per silence episode, and only when it is actionable:
            // either the job is clearly waiting for input, or it has been quiet
            // long enough that "keep waiting or discard" is the real question.
            const alreadyReported = args.job?.quietSilenced === true;
            if (!alreadyReported && quietFor >= quietMs && policyAllowsDecision()) {
                const tail = tailOf(args.logPath, STALL_TAIL_BYTES);
                const blocked = tail.length > 0 && looksLikePrompt(tail);
                if (blocked || quietFor >= quietLongMs) {
                    if (args.job) args.job.quietSilenced = true;
                    sendDecision(
                        args.pi,
                        args.jobId,
                        args.command,
                        args.logPath,
                        quietFor,
                        blocked,
                        args.deliver?.() ?? DELIVER_FOLLOWUP
                    );
                }
            }
        } catch {
            /* Log may not exist yet — retry next tick. */
        }
        timer.refresh();
    }, args.intervalMs ?? STALL_CHECK_INTERVAL_MS);
    timer.unref();

    return () => {
        cancelled = true;
        clearTimeout(timer);
    };
}

// --- Prompt pattern matching (hint only) ---------------------------------

/** Patterns that identify an interactive prompt. Used to enrich a quiet
 *  notice, never to trigger one. */
export const PROMPT_PATTERNS = [
    /\(y\/n\)/i,
    /\[y\/n\]/i,
    /\(yes\/no\)/i,
    /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
    /Press (any key|Enter)/i,
    /Continue\?/i,
    /Overwrite\?/i,
];

/** True when the last line of the tail matches a prompt pattern. */
export function looksLikePrompt(tail: string): boolean {
    const lastLine = tail.trimEnd().split("\n").pop() ?? "";
    return PROMPT_PATTERNS.some((p) => p.test(lastLine));
}

// --- Notices -------------------------------------------------------------

/** Read up to `bytes` from the end of the log, trailing whitespace trimmed. */
function tailOf(logPath: string, bytes: number): string {
    try {
        const { size } = fsStatSync(logPath);
        if (size === 0) return "";
        const fd = openSync(logPath, "r");
        try {
            const readStart = Math.max(0, size - bytes);
            const toRead = Math.min(size, bytes);
            const buf = Buffer.alloc(toRead);
            readSync(fd, buf, 0, toRead, readStart);
            return buf.toString("utf-8", 0, toRead).trimEnd();
        } finally {
            closeSync(fd);
        }
    } catch {
        return "";
    }
}

function sendDecision(
    pi: ExtensionAPI,
    jobId: string,
    command: string,
    logPath: string,
    quietForMs: number,
    blocked: boolean,
    deliver: Delivery
): void {
    const mins = Math.round((quietForMs / 60_000) * 10) / 10;
    const tail = blocked ? tailOf(logPath, STALL_TAIL_BYTES) : "";
    const head = blocked
        ? `Background job ${jobId} looks blocked on input — its stdin is /dev/null, so it cannot be answered.`
        : `Background job ${jobId} has been quiet for ${mins}m (still running).`;
    pi.sendMessage(
        {
            customType: EVENT.stall,
            content:
                `${head}\n` +
                `Command: ${command}\n` +
                (tail ? `Last output:\n${tail}\n` : "") +
                `Decide: \`job_decide ${jobId} keep|kill|check\` ` +
                `(keep = stop asking about this silence; fresh output starts a new episode).`,
            display: true,
            details: { jobId, logPath, command },
        },
        deliver
    );
}

/**
 * Activity-based quiet detection for background jobs.
 *
 * Watches a job's log file and tells the agent when a *running* job has gone
 * quiet — no output for a while — so the user/agent can decide to wait, check,
 * or kill. Output silence alone never kills a job; only the MAX_LOG_BYTES
 * oversize guard terminates. The interactive-prompt regex is a hint in the
 * notice, not the trigger: a job that stops printing may be working (a long
 * link step), blocked on input, or genuinely hung, and only the user/agent can
 * tell those apart.
 *
 * Progress streaming lives in output.ts (pollFileTail).
 */

import { openSync, readSync, closeSync, statSync as fsStatSync } from "node:fs";
import { setTimeout as nodeSetTimeout } from "node:timers";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    DELIVER_FOLLOWUP,
    EVENT,
    MAX_LOG_BYTES,
    QUIET_LONG_MS,
    QUIET_MS,
    STALL_CHECK_INTERVAL_MS,
    STALL_TAIL_BYTES,
} from "./types.ts";

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
    onOversize?: () => void;
    /** Skip the quiet watch (used for monitors, which stream their own events,
     *  so a quiet tail is normal rather than a stall). */
    disableQuietWatch?: boolean;
    /** Skip the oversize auto-kill (used for persistent monitors). */
    disableOversizeKill?: boolean;
    /** Called once when the job first goes quiet, so callers can mark it in the
     *  UI (the quiet notice itself is one-shot per episode). */
    onQuiet?: () => void;
}): () => void {
    let lastSize = 0;
    let lastGrowth = Date.now();
    let quietNotified = false;
    let quietLongNotified = false;
    let cancelled = false;

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
                        content: `⚠️ Background job ${args.jobId} exceeded ${MAX_LOG_BYTES / (1024 * 1024)} MiB output. Terminated.`,
                        display: true,
                        details: { jobId: args.jobId, logPath: args.logPath, command: args.command },
                    },
                    DELIVER_FOLLOWUP
                );
                return;
            }

            if (size > lastSize) {
                // Producing — any quiet episode ends here and its notices re-arm.
                lastSize = size;
                lastGrowth = Date.now();
                quietNotified = false;
                quietLongNotified = false;
            } else if (!args.disableQuietWatch) {
                const quietFor = Date.now() - lastGrowth;
                if (!quietLongNotified && quietFor >= QUIET_LONG_MS) {
                    quietLongNotified = true;
                    sendQuietLong(args.pi, args.jobId, args.command, args.logPath, quietFor);
                } else if (!quietNotified && quietFor >= QUIET_MS) {
                    quietNotified = true;
                    args.onQuiet?.();
                    sendQuiet(args.pi, args.jobId, args.command, args.logPath, quietFor);
                }
            }
        } catch {
            /* Log may not exist yet — retry next tick. */
        }
        timer.refresh();
    }, STALL_CHECK_INTERVAL_MS);
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

function sendQuiet(
    pi: ExtensionAPI,
    jobId: string,
    command: string,
    logPath: string,
    quietForMs: number
): void {
    const secs = Math.round(quietForMs / 1000);
    const tail = tailOf(logPath, STALL_TAIL_BYTES);
    const promptHint = tail && looksLikePrompt(tail)
        ? "\n⤷ The last line looks like an interactive prompt — it may be blocked on input."
        : "";
    const body =
        `⏸ Background job ${jobId} has produced no output for ${secs}s (still running).\n` +
        `Command: ${command}\n` +
        (tail ? `Last output:\n${tail}\n` : "") +
        `— waiting for output. \`jobs output ${jobId}\` to check, \`jobs kill ${jobId}\` to stop.` +
        promptHint;

    pi.sendMessage(
        {
            customType: EVENT.stall,
            content: body,
            display: true,
            details: { jobId, logPath, command },
        },
        DELIVER_FOLLOWUP
    );
}

function sendQuietLong(
    pi: ExtensionAPI,
    jobId: string,
    command: string,
    logPath: string,
    quietForMs: number
): void {
    const mins = Math.round((quietForMs / 60_000) * 10) / 10;
    pi.sendMessage(
        {
            customType: EVENT.stall,
            content:
                `⏸ Background job ${jobId} has been quiet for ${mins}m (still running).\n` +
                `Command: ${command}\n` +
                `Decide: \`job_decide ${jobId} keep|kill|check\`.`,
            display: true,
            details: { jobId, logPath, command },
        },
        DELIVER_FOLLOWUP
    );
}

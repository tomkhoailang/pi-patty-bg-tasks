/**
 * `job_decide` 툴 — 타임아웃된 백그라운드 잡에 대한 결정을 받는다.
 *
 * 결정:
 *   - keep: 계속 실행
 *   - kill: 종료
 *   - check: 현재 출력 확인
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import { OUTPUT_PREVIEW_CHARS } from "../types.ts";
import { findJob, readLogTail, renderSidebar } from "../registry.ts";
import { markOutcomeKnown, terminateJobSilently } from "../lifecycle.ts";
import { jobLabel, textBlock } from "../format.ts";

/** `job_decide` 툴을 등록한다. */
export function registerJobDecideTool(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    pi.registerTool({
        name: "job_decide",
        label: "Job Decision",
        description: "Decide whether to keep, kill, or check a timed-out background job.",
        promptSnippet: "Decide what to do with a timed-out background job",
        promptGuidelines: [
            "keep: let the job continue running",
            "kill: terminate the job",
            "check: inspect the current output",
        ],
        parameters: Type.Object({
            jobId: Type.String({ description: "Job ID to decide on" }),
            decision: StringEnum(["keep", "kill", "check"] as const, {
                description: "keep = continue, kill = terminate, check = inspect output",
            }),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const p = params as { jobId: string; decision: "keep" | "kill" | "check" };
            const job = findJob(reg, p.jobId);
            if (!job) {
                reg.pendingDecisionJobId = undefined;
                return {
                    content: [
                        textBlock(`Job ${p.jobId} not found.`),
                    ],
                    details: undefined,
                };
            }

            // The agent is resolving its decision on this job — it now knows
            // the outcome. Suppress the pending completion notice so the agent
            // isn't re-told about a job it just decided on (Claude Code's
            // `notified`-flag parity). No-op while still running; the kill
            // branch below also marks it silently via terminateJobSilently.
            markOutcomeKnown(job);

            switch (p.decision) {
                case "kill": {
                    terminateJobSilently(reg, job);
                    renderSidebar(reg, ctx);
                    return {
                        content: [textBlock(`Killed ${jobLabel(job)}.`)],
                        details: undefined,
                    };
                }
                case "keep": {
                    reg.pendingDecisionJobId = undefined;
                    // Mute THIS silence episode (not the job): the watcher stops
                    // asking until fresh output starts a new one. Without this,
                    // "keep" would just re-arm the same nag.
                    job.quietSilenced = true;
                    return {
                        content: [
                            textBlock(
                                `Keeping ${jobLabel(job)} running. Use jobs tool to check on it later.`
                            ),
                        ],
                        details: undefined,
                    };
                }
                case "check": {
                    const out = readLogTail(job, OUTPUT_PREVIEW_CHARS);
                    return {
                        content: [
                            textBlock(`Output of ${jobLabel(job)}:\n${out}`),
                        ],
                        details: undefined,
                    };
                }
            }
        },
    });
}

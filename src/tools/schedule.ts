// src/tools/schedule.ts
//
// `schedule` — a one-shot timer or a recurring cron-style job that notifies the
// agent later. Antigravity's `schedule` tool, adapted: the contract is stated in
// the description (read once), the result carries facts only, and the schedule
// lives as a normal job so `jobs list|kill` manages it and the snapshot makes it
// durable.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import type { UiContext } from "../types.ts";
import { createTimerJob, resolveSchedule } from "../scheduler.ts";
import { renderSidebar } from "../registry.ts";
import { textBlock } from "../format.ts";

export function registerScheduleTool(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.registerTool({
        name: "schedule",
        label: "Schedule",
        description:
            "Schedule a one-shot timer (`in`/`at`) or a recurring job (`every`) that notifies you " +
            "later. Returns at once as a normal background job — there is nothing to do meanwhile; " +
            "the fire wakes you when the agent is idle. Cancel with jobs action='kill', list with " +
            "jobs action='list'. Never use a shell `sleep` as a timer.",
        promptSnippet: "Schedule a one-shot or recurring wake-up",
        promptGuidelines: [
            "Use schedule to come back to something later: retry a deploy, re-check a rollout, run a periodic audit.",
            "`every` takes a duration (30s, 5m, 2h, 1d) or a 5-field cron expression (minute hour day-of-month month day-of-week), e.g. '*/30 * * * *'.",
            "A fire with a `prompt` wakes you and runs that prompt; without one you get a short notice only.",
            "Bound recurring work with maxFires, and set cancelOnActivity when the timer is a heartbeat that should stop as soon as real work finishes.",
            "Never hold a turn open waiting for a timer: the fire comes to you.",
        ],
        parameters: Type.Object({
            in: Type.Optional(Type.String({ description: "One-shot delay from now, e.g. 30s, 10m, 2h" })),
            at: Type.Optional(Type.String({ description: "One-shot absolute time (ISO 8601)" })),
            every: Type.Optional(
                Type.String({ description: "Recurring: a duration (5m) or a 5-field cron expression" })
            ),
            prompt: Type.Optional(
                Type.String({ description: "Text to run on fire (wakes the agent); omit for a plain notice" })
            ),
            reason: Type.Optional(Type.String({ description: "Label shown in jobs list" })),
            maxFires: Type.Optional(Type.Number({ description: "Stop after this many fires" })),
            cancelOnActivity: Type.Optional(
                Type.Boolean({ description: "Cancel when any other job completes (heartbeat pattern)" })
            ),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const p = params as {
                in?: string;
                at?: string;
                every?: string;
                prompt?: string;
                reason?: string;
                maxFires?: number;
                cancelOnActivity?: boolean;
            };
            const resolved = resolveSchedule({ in: p.in, at: p.at, every: p.every });
            if ("error" in resolved) throw new Error(resolved.error);
            if (p.maxFires !== undefined && (!Number.isInteger(p.maxFires) || p.maxFires <= 0)) {
                throw new Error("maxFires must be a positive integer.");
            }

            const job = createTimerJob(reg, {
                fireAt: resolved.fireAt,
                everyMs: resolved.everyMs,
                prompt: p.prompt,
                reason: p.reason,
                maxFires: p.maxFires,
                cancelOnActivity: p.cancelOnActivity,
            });
            renderSidebar(reg, ctx as unknown as UiContext);

            const when = new Date(resolved.fireAt).toISOString();
            return {
                content: [
                    textBlock(
                        `Scheduled ${job.id}${p.reason ? ` (${p.reason})` : ""}.\n` +
                            `Next fire: ${when}${resolved.everyMs ? `, repeating every ${Math.round(resolved.everyMs / 1000)}s` : ""}` +
                            `${p.maxFires ? `, max ${p.maxFires} fires` : ""}.\n` +
                            (p.prompt ? `Prompt: ${p.prompt}\n` : "") +
                            `Nothing to do meanwhile.`
                    ),
                ],
                details: undefined,
            };
        },
    });
}

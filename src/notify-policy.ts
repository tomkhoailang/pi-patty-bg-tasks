/**
 * How much background-job news reaches the agent.
 *
 * Policy shape mirrors Hermes' `display.background_process_notifications`, because
 * the research (docs/antigravity-background-tasks.md §8 Q2/Q5) converges there and
 * in Claude Code on the same conclusion: **completion-only by default, watching is
 * opt-in, and every push is budgeted**.
 *
 *   off      nothing at all
 *   error    terminal notices, failures only
 *   result   every terminal notice
 *   concise  (default) terminal notices + decision events
 *   all      concise + progress watches (quiet/update pushes)
 *
 * Lives apart from monitoring.ts and notify.ts so neither has to import the other
 * (monitoring decides *whether* to speak; notify decides *how* it is delivered).
 */

import {
    NOTIFY_POLICY,
    type NotifyPolicy,
} from "./types.ts";

export type { NotifyPolicy };
export { NOTIFY_POLICY };

/** Terminal (job-finished) notices: allowed by every policy except `off`, and
 *  only failures under `error`. */
export function policyAllowsTerminal(
    status: string,
    policy: NotifyPolicy = NOTIFY_POLICY
): boolean {
    if (policy === "off") return false;
    if (policy === "error") return status === "failed";
    return true; // result | concise | all
}

/** Decision events ("this needs an answer"). These are the one push the agent
 *  cannot pull for itself, so only the summary-shaped policies drop them. */
export function policyAllowsDecision(policy: NotifyPolicy = NOTIFY_POLICY): boolean {
    return policy === "concise" || policy === "all";
}

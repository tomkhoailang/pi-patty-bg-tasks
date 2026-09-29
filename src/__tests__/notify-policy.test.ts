// src/__tests__/notify-policy.test.ts
//
// `PI_PATTY_BG_NOTIFY` shapes how much background-job news reaches the agent
// (§8 Q2/Q5): completion-only by default, decisions only where they are useful.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { NOTIFY_POLICY, policyAllowsDecision, policyAllowsTerminal } from "../notify-policy.ts";

describe("notify policy", () => {
    test("defaults to concise", () => {
        assert.equal(NOTIFY_POLICY, "concise");
    });

    test("terminal notices: every policy but `off`, failures-only under `error`", () => {
        assert.equal(policyAllowsTerminal("completed", "off"), false);
        assert.equal(policyAllowsTerminal("failed", "off"), false);
        assert.equal(policyAllowsTerminal("completed", "error"), false);
        assert.equal(policyAllowsTerminal("failed", "error"), true);
        for (const p of ["result", "concise", "all"] as const) {
            assert.equal(policyAllowsTerminal("completed", p), true, p);
            assert.equal(policyAllowsTerminal("failed", p), true, p);
        }
    });

    test("decision events survive unless the policy is minimal", () => {
        assert.equal(policyAllowsDecision("concise"), true);
        assert.equal(policyAllowsDecision("all"), true);
        assert.equal(policyAllowsDecision("result"), false);
        assert.equal(policyAllowsDecision("error"), false);
        assert.equal(policyAllowsDecision("off"), false);
    });
});

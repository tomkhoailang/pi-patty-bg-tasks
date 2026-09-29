// src/__tests__/background-command.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    prefersPty,
    firstRealProgram,
    ptyArgv,
    ptyEnv,
    UNATTENDED_ENV,
} from "../background-command.ts";

// NOTE: the strip/reject policy was removed — commands are never rewritten, so
// there is no `prepareBackgroundCommand` to test. A trailing buffering sink
// (`| tail -80`) is the command's own semantics. What remains here is the spawn
// SHAPE choice (PTY vs file-fd).

describe("prefersPty", () => {
    test("true for TTY-gated dev/build/test tools", () => {
        for (const cmd of ["npm run dev", "pnpm install", "vite build", "cargo nextest run"]) {
            assert.equal(prefersPty(cmd), true, cmd);
        }
    });

    test("false for everything else", () => {
        for (const cmd of ["ls -la", "grep foo bar", "sleep 1"]) {
            assert.equal(prefersPty(cmd), false, cmd);
        }
    });

    test("sees past wrappers, env assignments, and cd chains", () => {
        assert.equal(firstRealProgram("cd ~/x && npm run dev"), "npm");
        assert.equal(firstRealProgram("sudo pnpm install"), "pnpm");
        assert.equal(firstRealProgram("timeout 30 cargo build"), "cargo");
        assert.equal(firstRealProgram("FOO=1 BAR=2 vite build"), "vite");
        assert.equal(firstRealProgram("cd /tmp; cd /var && jest"), "jest");
        assert.equal(firstRealProgram("nohup webpack serve"), "webpack");
        assert.equal(firstRealProgram("sudo timeout 60 cargo nextest run"), "cargo");
        assert.equal(prefersPty("cd ~/proj && npm run dev"), true);
        assert.equal(prefersPty("ls -la"), false);
    });
});

describe("ptyArgv", () => {
    test("returns script argv on linux, or null when unavailable", () => {
        const argv = ptyArgv("npm run dev");
        if (process.platform === "linux") {
            assert.ok(argv === null || (argv[0] === "-qefc" && argv[1] === "npm run dev"));
        } else {
            assert.equal(argv, null);
        }
    });
});

describe("UNATTENDED_ENV", () => {
    test("disables pagers and prompts so a PTY job cannot block on input", () => {
        assert.equal(UNATTENDED_ENV.PAGER, "cat");
        assert.equal(UNATTENDED_ENV.GIT_PAGER, "cat");
        assert.equal(UNATTENDED_ENV.GIT_TERMINAL_PROMPT, "0");
    });
});

describe("ptyEnv", () => {
    test("forces a bash login shell (script -c otherwise uses $SHELL, e.g. fish)", () => {
        const env = ptyEnv();
        assert.ok(env.SHELL.endsWith("bash"), env.SHELL);
        assert.equal(env.PAGER, "cat");
        assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    });
});

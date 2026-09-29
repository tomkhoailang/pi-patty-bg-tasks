// src/__tests__/background-command.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    prepareBackgroundCommand,
    prefersPty,
    firstRealProgram,
    ptyArgv,
    UNATTENDED_ENV,
} from "../background-command.ts";

describe("prepareBackgroundCommand", () => {
    test("leaves a plain command untouched", () => {
        assert.deepEqual(prepareBackgroundCommand("cargo check"), { command: "cargo check" });
    });

    test("strips a trailing finite tail (redundant with the log tail)", () => {
        assert.deepEqual(prepareBackgroundCommand("cargo check | tail -80"), {
            command: "cargo check",
            stripped: "tail",
        });
        assert.deepEqual(prepareBackgroundCommand("make 2>&1 | tail"), {
            command: "make 2>&1",
            stripped: "tail",
        });
    });

    test("keeps a streaming tail -f", () => {
        assert.deepEqual(prepareBackgroundCommand("tail -f app.log"), { command: "tail -f app.log" });
        assert.deepEqual(prepareBackgroundCommand("tail -F app.log | grep x"), {
            command: "tail -F app.log | grep x",
        });
    });

    test("rejects semantics-changing sinks", () => {
        for (const cmd of ["x | head -5", "x | sort", "x | uniq -c", "x | jq .a"]) {
            assert.throws(() => prepareBackgroundCommand(cmd), /Blocked:/, cmd);
        }
    });

    test("ignores pipes inside quotes", () => {
        assert.deepEqual(prepareBackgroundCommand("echo 'a|b'"), { command: "echo 'a|b'" });
        assert.deepEqual(prepareBackgroundCommand('printf "x|y"'), { command: 'printf "x|y"' });
    });

    test("does not split on logical OR (`||`)", () => {
        assert.deepEqual(prepareBackgroundCommand("a || b"), { command: "a || b" });
    });
});

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

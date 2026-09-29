/**
 * Spawn-shape choice for background commands.
 *
 * A background job's stdout/stderr are written straight to its log file, so a
 * tool that gates progress on `isatty()` (npm/vite/webpack/jest/…) prints
 * nothing. For those we run under a PTY (`script`), which also keeps
 * libc/Python line-buffered.
 *
 * The command text is NEVER rewritten: it runs verbatim, so its exit code,
 * SIGPIPE behaviour, and stderr are exactly the caller's. A command ending in a
 * buffering sink (`| tail -80`) therefore produces no live output by its own
 * choosing — that is the command's semantics, not ours to fix.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** Unattended env for the PTY path: disable pagers/prompts so an interactive
 *  tool cannot block a background job waiting for input. */
export const UNATTENDED_ENV: Record<string, string> = {
    PAGER: "cat",
    GIT_PAGER: "cat",
    BAT_PAGER: "cat",
    LESS: "FRX",
    GIT_TERMINAL_PROMPT: "0",
    DEBIAN_FRONTEND: "noninteractive",
};

/** Programs whose useful live progress only appears on a TTY. */
const PTY_SAFE_COMMANDS = new Set([
    "npm", "npx", "pnpm", "yarn", "bun", "deno",
    "vite", "webpack", "next", "turbo", "parcel", "esbuild", "rollup",
    "jest", "vitest", "playwright", "cypress", "karma",
    "cargo", "cargo-watch", "cargo-nextest", "nextest",
    "tsc", "tsx", "nodemon", "uvicorn", "gunicorn",
]);

/** Split a command on top-level `|` pipes, ignoring pipes inside quotes. */
function splitPipeline(command: string): string[] {
    const parts: string[] = [];
    let current = "";
    let quote: "'" | '"' | null = null;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote) {
            current += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === "\\") {
            current += ch + (command[i + 1] ?? "");
            i++;
            continue;
        }
        if (ch === "|") {
            // `||` is a logical OR, not a pipe — keep it in the stage.
            if (command[i + 1] === "|") {
                current += "||";
                i++;
                continue;
            }
            parts.push(current);
            current = "";
            if (command[i + 1] === "&") i++;
            continue;
        }
        current += ch;
    }
    parts.push(current);
    return parts;
}

const basename = (word: string): string => word.split("/").pop() ?? word;

/** Wrappers that prefix the real program (`sudo npm …`, `timeout 30 cargo …`). */
const WRAPPERS = new Set([
    "sudo", "doas", "time", "nohup", "env", "command", "exec", "nice",
    "ionice", "stdbuf", "setsid", "timeout",
]);
const CD_LIKE = new Set(["cd", "pushd", "popd"]);

/** Split a segment on shell sequencing (`&&`, `||`, `;`, newline), quote-aware. */
function splitSteps(segment: string): string[] {
    const steps: string[] = [];
    let current = "";
    let quote: "'" | '"' | null = null;
    for (let i = 0; i < segment.length; i++) {
        const ch = segment[i];
        if (quote) {
            current += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === "\\") {
            current += ch + (segment[i + 1] ?? "");
            i++;
            continue;
        }
        const two = segment.slice(i, i + 2);
        if (two === "&&" || two === "||") {
            steps.push(current);
            current = "";
            i++;
            continue;
        }
        if (ch === ";" || ch === "\n") {
            steps.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    steps.push(current);
    return steps;
}

/**
 * The first real program in a command, looking past `VAR=…`, wrappers
 * (`sudo`/`time`/`nohup`/`timeout …`), and leading `cd … &&` steps, so
 * `cd ~/x && npm run dev` classifies as `npm`.
 */
export function firstRealProgram(command: string): string {
    const stage = splitPipeline(command)[0] ?? "";
    let fallback = "";
    for (const step of splitSteps(stage)) {
        const words = step
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
        let i = 0;
        while (i < words.length && WRAPPERS.has(basename(words[i]))) {
            const wrapper = basename(words[i]);
            i++;
            while (i < words.length && words[i].startsWith("-")) i++;
            if (wrapper === "timeout" && i < words.length) i++; // skip the duration
        }
        const program = words[i] ? basename(words[i]) : "";
        if (!program) continue;
        if (!fallback) fallback = program;
        if (!CD_LIKE.has(program)) return program;
    }
    return fallback;
}

/** True when the command's program needs a TTY for live progress. */
export function prefersPty(command: string): boolean {
    return PTY_SAFE_COMMANDS.has(firstRealProgram(command));
}

/** True when `script(1)` is available to allocate a PTY (Linux, util-linux). */
export function scriptAvailable(): boolean {
    return process.platform === "linux" && onPath("script");
}

/** The `script(1)` argv that runs `command` under a PTY, or null when `script`
 *  is unavailable (BSD/macOS `script` takes different flags — skip there). */
export function ptyArgv(command: string): string[] | null {
    if (!scriptAvailable()) return null;
    // -q quiet, -e propagate the child exit code, -f flush per write (live),
    // -c run the command, typescript to /dev/null (we only want its stdout).
    return ["-qefc", command, "/dev/null"];
}

function onPath(bin: string): boolean {
    return findOnPath(bin) !== null;
}

/** First executable named `bin` on PATH, or null. */
function findOnPath(bin: string): string | null {
    const path = process.env.PATH ?? "";
    for (const dir of path.split(delimiter)) {
        if (!dir) continue;
        const candidate = join(dir, bin);
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch {
            /* keep looking */
        }
    }
    return null;
}

/** Env for the PTY path: unattended pagers/prompts plus a bash login shell.
 *  `script -c` runs the command through `$SHELL`, which may be fish/zsh, so we
 *  force bash to match the file-fd path (`bash -c <cmd>`). */
export function ptyEnv(): Record<string, string> {
    return { ...UNATTENDED_ENV, SHELL: findOnPath("bash") ?? "/bin/bash" };
}

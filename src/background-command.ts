/**
 * Liveness guard for background commands.
 *
 * A background job's stdout/stderr are written straight to its log file, and the
 * log fd belongs to the LAST pipeline stage. Two failure modes make the live view
 * (the user's expanded row) look empty even though the job is producing output:
 *
 *   1. A trailing buffering sink (`| tail`, `| head`, `| sort`, `| uniq`, `| jq`)
 *      holds everything until EOF, so the log stays 0 bytes for the whole run.
 *   2. A tool that gates progress on `isatty()` (npm/vite/webpack/jest/…) prints
 *      nothing when stdout is a file. For those we run under a PTY (`script`),
 *      which also keeps libc/Python line-buffered.
 *
 * This module normalizes the command (strip/reject sinks) and decides the spawn
 * shape (plain file-fd vs PTY). It is applied ONLY at background-at-spawn sites,
 * so ordinary fast foreground `| head`/`| tail` keep their exact semantics.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** Sinks that fully buffer a stream, so live output is hidden until EOF. */
const REJECT_SINKS = new Set(["head", "sort", "uniq", "jq"]);

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

export const BUFFERING_SINK_GUIDANCE =
    "A background job's output is captured in full and streamed live to the user, " +
    "so do NOT pipe it through a buffering sink (`tail`/`head`/`sort`/`uniq`/`jq`): " +
    "the log stays empty until the pipeline ends and the user sees nothing. " +
    "Run the command bare, then read the tail with jobs action='output'.";

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

/** Basename of a stage's program, skipping leading `VAR=value` assignments. */
function stageCommand(segment: string): { name: string; args: string[] } {
    const words = segment
        .trim()
        .split(/\s+/)
        .filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const first = words[0] ?? "";
    return { name: basename(first), args: words.slice(1) };
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

export interface PreparedBackgroundCommand {
    command: string;
    /** The sink stripped from the command, if any (surfaced to the agent). */
    stripped?: string;
}

/**
 * Normalize a command for background execution: strip a trailing finite `tail`
 * (redundant — pi already tails the log), and reject the semantics-changing
 * sinks. Throws on a reject sink so the caller surfaces the guidance.
 */
export function prepareBackgroundCommand(command: string): PreparedBackgroundCommand {
    const parts = splitPipeline(command);
    if (parts.length < 2) return { command };
    const last = stageCommand(parts[parts.length - 1]);
    if (REJECT_SINKS.has(last.name)) {
        throw new Error(
            `Blocked: \`${last.name}\` on a background command. ${BUFFERING_SINK_GUIDANCE}`
        );
    }
    const isFollow = last.args.some((a) => /^-[A-Za-z]*[fF]/.test(a) || a === "--follow");
    if (last.name === "tail" && !isFollow) {
        return { command: parts.slice(0, -1).join("|").trim(), stripped: "tail" };
    }
    return { command };
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
    const path = process.env.PATH ?? "";
    for (const dir of path.split(delimiter)) {
        if (!dir) continue;
        try {
            accessSync(join(dir, bin), constants.X_OK);
            return true;
        } catch {
            /* keep looking */
        }
    }
    return false;
}

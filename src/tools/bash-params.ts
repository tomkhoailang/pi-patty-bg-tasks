/**
 * Shared bash parameter schema (TypeBox) used by the overridden `bash` tool.
 */

import { Type } from "@earendil-works/pi-ai";

export const bashParamSchema = Type.Object({
    command: Type.String({ description: "Shell command to run" }),
    timeout: Type.Optional(
        Type.Number({ description: "Timeout in seconds (default: 120)" })
    ),
    run_in_background: Type.Optional(
        Type.Boolean({
            description:
                "Set to true to run this command in the background immediately. " +
                "Output is saved to /tmp/pi-bg/<jobId>.log.",
        })
    ),
    description: Type.Optional(
        Type.String({ description: "Short description of what this command does" })
    ),
    pty: Type.Optional(
        Type.Boolean({
            description:
                "Only with run_in_background: run under a PTY so TTY-gated tools " +
                "(npm/vite/webpack/jest/...) show live progress. Auto-enabled for those.",
        })
    ),
});

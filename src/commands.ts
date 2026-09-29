/**
 * 슬래시 커맨드 등록.
 *
 *   - /bg: Ctrl+Shift+B와 동일 — 포그라운드 프로세스를 백그라운드로
 *   - /bg-list: 인터랙티브 백그라운드 작업 매니저 열기
 *   - /bg-version: 현재 로드된 확장 버전/경로 확인
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import type { UiContext } from "./types.ts";
import { takeControl, type ControlContext } from "./lifecycle.ts";
import { openBgListPanel } from "./ui.ts";
import { openTaskMonitor } from "./task-monitor.ts";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageRoot = dirname(packageJsonPath);

/** 모든 슬래시 커맨드를 등록한다. */
export function registerCommands(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    pi.registerCommand("bg", {
        description: "Background the current process and hand control to the agent",
        handler: async (_args, ctx) => {
            takeControl(reg, pi, ctx as unknown as ControlContext);
        },
    });

    pi.registerCommand("bg-list", {
        description: "Open the interactive background task manager",
        handler: async (_args, ctx: ExtensionCommandContext) => {
            await openBgListPanel(reg, ctx);
        },
    });

    pi.registerCommand("monitor-task", {
        description: "Open the Task Monitor (task list + live output)",
        handler: async (_args, ctx: ExtensionCommandContext) => {
            await openTaskMonitor(reg, ctx as unknown as UiContext, "all");
        },
    });

    pi.registerCommand("bg-version", {
        description: "Show the loaded background tasks extension version",
        handler: async (_args, ctx) => {
            const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
                name?: string;
                version?: string;
            };
            ctx.ui.notify(
                `${pkg.name ?? "pi-patty-bg-tasks"}@${pkg.version ?? "unknown"} loaded from ${packageRoot}`,
                "info"
            );
        },
    });
}

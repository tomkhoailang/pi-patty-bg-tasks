/**
 * Shared mutable state for the background-tasks extension.
 *
 * One instance per session, threaded through every tool and helper.
 */

import type { Job, ForegroundSlot, MonitorEnd, StripTui } from "./types.ts";

export class BackgroundRegistry {
    jobs = new Map<string, Job>();
    foreground = new Map<string, ForegroundSlot>();
    counter = 0;
    activeToolCallId: string | null = null;
    pendingDecisionJobId: string | undefined;

    /** Per-job AbortController — abort() cancels all monitors/pollers for that job. */
    jobAborts = new Map<string, AbortController>();

    nonInteractive = false;

    completedCount = 0;
    failedCount = 0;
    totalStarted = 0;
    totalDurationMs = 0;
    recentTerminal: Job[] = [];

    /** Live-duration ticker for the sidebar pills; runs while jobs are alive. */
    sidebarTimer: NodeJS.Timeout | undefined = undefined;
    /** Last rendered status-bar text — used to skip redundant setStatus calls. */
    lastSidebarContent: string | undefined = undefined;
    /** Last status-line text, tracked separately for the non-component widget path. */
    lastStatusText: string | undefined = undefined;
    /** True while the clickable strip component is installed as the widget.
     *  The component path installs once; updates go through requestRender(). */
    stripInstalled = false;
    /** TUI handle captured from the widget factory — drives strip re-renders. */
    stripTui: StripTui | undefined = undefined;
    /** True while the strip shows every eligible row instead of the collapsed
     *  line budget (STRIP_VISIBLE_LINES × columns). Toggled by clicking the
     *  strip's toggle line. */
    stripExpanded = false;
    /** Job id whose row is expanded inline in the strip, if any. */
    stripExpandedJob: string | undefined = undefined;
    /** Injected from index.ts. registry.ts cannot import lifecycle.ts (which
     *  imports registry.ts), so the strip's `x` kill routes through here. */
    killJob: ((job: Job) => void) | undefined = undefined;

    /** Finished jobs + monitor terminals awaiting a coalesced notice (notify.ts).
     *  Buffered so a whole turn's worth of finishes surfaces as one summary, not
     *  a wall dumped after the agent's reply. */
    pendingFinished: Job[] = [];
    pendingMonitorEnds: MonitorEnd[] = [];
    /** True while the agent is mid-turn (between agent_start and agent_end).
     *  Notices flush at agent_end then, not on the idle fallback timer. */
    agentBusy = false;
    /** Idle-only coalescing fallback timer (armed only when the agent is idle). */
    noticeFlushTimer: NodeJS.Timeout | undefined = undefined;
}

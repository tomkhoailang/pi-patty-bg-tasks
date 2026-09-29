# Antigravity task system — implementation decode

Reverse-engineered from the shipped `agy` binary (`/home/hj/.local/bin/agy`, **v1.2.13**,
sha256 `574b0234656c44564f3ff3b013225c86…`), fetched 2026-09-29. This is the *implementation*
counterpart to `antigravity-background-tasks.md` (which is the behavioural contract).

Methods used, both reproducible:

1. **Symbol scan** — `strings -n 6 agy` then grep for Go package paths (`framework/task`,
   `utils/background`, `framework/core`, `framework/executor`, `cortex/tools`, `cli/commands`).
2. **Template scan** — find every Go-template block (`{{- /* … */ -}}` headers; 26 in the
   binary) and dump the bytes that follow. This recovers prompt/result copy *verbatim*.

Each claim below is tagged **verified** (present as a symbol/enum/template body) or
**inferred**/**unknown** (§7–§8).

---

## 1. Layers

| Layer | Symbols (**verified**) | Role |
|---|---|---|
| **Pool** — `utils/background` | `NewPool · (*Pool).Go · (*Pool).AwaitIdle() · (*Pool).close() · ctxWithTask.Value · (*task).Cancel · (*task).AfterFunc` | Owns the goroutines. `Go(fn)` runs work *as a task*. `AwaitIdle` is what produces `root agent idle; waiting up to %s for %d background task(s)` and `"fullyIdle": true`. **Timers are `AfterFunc`** — there is no separate scheduler subsystem. |
| **Task** — `framework/task` | `task.New(ctx, opts…)`; handle `TaskID · Description · LogProgress · LogURI · Notify · Receive · ReceiveCh · SuppressCompletionNotification`; `CreateTaskID / ParseTaskID / ParseLocalTaskID`; `taskImpl.initLogFile`; `NewNoOpHandle` | The unit of long-running work: **a log file + two channels** (notify out, receive in) + flags. `NewNoOpHandle` means callers instrument unconditionally; with no pool in the ctx it costs nothing. |
| **Backgrounder** — `framework/core` | `MoveToBackground · OnTaskStarted · OnTaskCompleted` (+ `disabledBackgrounder` no-op) | The hook that turns a tool invocation into a background task. |
| **Trajectory / executor** | `asyncHandleStep · WaitExecutorBlocking · WaitInvocationBlocking · SetStep · AppendStep · (*ExecutionTrajectory).maybeSendTaskNotification` | Owns async steps and decides when a task notification is emitted. |
| **Step layer** | `CORTEX_STEP_STATUS_*`; per-tool templates `run_command.tmpl`, `send_command_input.tmpl`, `default_status_output_string.tmpl` | Every tool call is a **Step**, rendered to the model by a template. |
| **CLI views** | `cli/commands/tasks.go`, `cli/model/tasks_panel.go`, status line "Show active subagents and background tasks below the input box" | `/tasks` panel + one-line-per-item status strip. |

## 2. Data model

**Task options** (functional options, **verified**):
```
WithTitle · WithDescription · WithLogPath
WithIsDaemon                       // outlives the current task; auto-resumes after restart
WithSuppressCompletionNotification // per-task notice opt-out
WithRequiresInputApproval          // gate before input is delivered
```

**The same knobs exist for MCP tools** (**verified**) — i.e. the framework is uniform across
shell, tools, MCP and subagents:
```
McpTaskOptions { suppress_completion_notification, display_name, description }
McpServerToolConfig { background, eager, task_options }
```

**Two state machines** (**verified**, both appear as schema enums):
```
TaskState : running · idle · waiting_for_input · waiting_for_dependents · waiting_for_message
            · canceling · errored · unspecified
StepStatus: UNSPECIFIED · PENDING · RUNNING · WAITING · DONE · CANCELED · ERROR · INVALID
```

## 3. Lifecycle, with the verbatim strings the model sees

### 3.1 Launch / background
The command tool exposes `Background` and `IsDaemon` (**verified** schema tags).
Backgrounded result — **runtime text (captured, §8)**:
```
Tool is running as a background task with task id: <conversation-id>/task-N
Task logs are available at: file:///home/hj/.gemini/antigravity-cli/brain/<conv>/.system_generated/tasks/task-N.log
YOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: A) … B) … DO NOTHING ELSE.
```
The template variant (`step_strings/run_command.tmpl`, **verified**, verbatim) is what the
converter provides for the same situation:
```
Background command ID: {{ $commandId }}
Output snapshot:
{{ $combinedOutputSnapshot.GetFull }}
```
**Correction to an earlier reading:** the A/B rule *is* appended to the step result (the helper is
named `system_prompts/helpers/async_termination_rule.tmpl` but is consumed when rendering step
output — hence its 5 occurrences). What Antigravity removed from results is the *different*
anti-poll nudge (their changelog: it "could itself nudge the model into a polling loop"). So:
**"what to do next" stays in the result; "don't poll" does not.**
Foreground result, in order: a note if the *user edited* the command → cancel text → sandbox
guidance → output section. Selection of exactly-rendered lines:
```
The user changed the command to be run to: <cmd>
Step was canceled: <shortError>            (or)  Step was canceled.
The command exited with code <N>.
This command includes call(s) to `<cli>`, which MUST run inside the sandbox, so `BypassSandbox`
  was not applied to this command. …
There were sandbox errors that may or may not be related to the failure. …
Output:
<full>            (or)   Stdout:/Stderr:  …   (or)   No output
Terminal ID: {{ $runCommand.GetTerminalId }}     ← persistent terminal handle
```
Note what is absent: **no instructions, no "don't poll", no attach hint.** The contract lives in
the system prompt (§5). This is the same lesson recorded in `antigravity-background-tasks.md` §10.3.

### 3.2 While it runs — `default_status_output_string.tmpl` (**verified**, verbatim mapping)
```
CANCELED        → "Step was canceled: <shortError>"
ERROR           → "Encountered error in step execution: <shortError>"
INVALID         → "Error invalid tool call: <shortError>"  |  "Error: <shortError>"
PENDING/RUNNING → "Step is still running"
WAITING         → "Step is WAITING for user approval"      ← the requires-input state
DONE            → "" (empty)
```

### 3.3 Input into a running task — `step_strings/send_command_input.tmpl` (**verified**)
`send_input` is modelled as a *step*, not a raw stdin write:
```
Input sent successfully.
  running  → "The command is still running."
  else     → "The command exited with code <N>."
  output   → "Output:\n<full output>"
```
Input is **structured** — `$sendInput.GetOutput · GetExitCode · GetRunning` (**verified**).
The target is a persistent terminal (`Terminal ID` from §3.1).

**Runtime text (captured, §8)** — the tool result is plainer than the template:
```
Input sent to task "<conversation-id>/task-N".
```

### 3.4 Time — timers and crons are `task.AfterFunc`
Cron fire notification (**verified**, verbatim): `[%s] Cron triggered (iteration %d).`
`schedule` parameters (**verified** schema): `DurationSeconds` **or** `CronExpression` (5-field,
mutually exclusive) · `Prompt` · `MaxIterations` · `IsDaemon` · `TimerCondition: never | any | <senderId>`.
`Prompt` is described to the model as *"Message sent to you as a high-priority notification when
the timer fires or the cron triggers."*

### 3.5 Completion — **captured verbatim (§8)**
`(*ExecutionTrajectory).maybeSendTaskNotification` (**verified symbol**) emits a **high-priority
system message**; per-task suppression via `WithSuppressCompletionNotification` / `McpTaskOptions`:
```
The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as
important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-29T11:15:26Z sender=<conversation-id>/task-10 priority=MESSAGE_PRIORITY_HIGH
content=Task id "<conversation-id>/task-10" finished with result:

The command exited with code 0.
Stdout:
<...>
Stderr:
<...>

Log: file:///home/hj/.gemini/antigravity-cli/brain/<conv>/.system_generated/tasks/task-10.log
</SYSTEM_MESSAGE>
```
Two things to steal from this shape:
1. **Attribution is explicit** — "not actually sent by the user" plus `sender=<task-id>`. That is the
   mechanism that prevents a notice from reading as the user's own words (our `v1.6.48` fix on the pi
   side does the same by delivering `followUp` instead of `steer`).
2. The body is the **step result renderer** (exit code + stdout/stderr + a `file://` log URI), so the
   notice never carries a bespoke format.
`priority=MESSAGE_PRIORITY_HIGH` is what makes an idle agent act on it.

### 3.6 Idle and shutdown
`Pool.AwaitIdle` + the `fullyIdle` flag; `terminating %d background task(s) and %d daemon task(s) on exit`;
headless runs wait for tasks up to `--print-timeout` (cap 30 min) and leave daemons running;
`[Notice] All your background tasks have been stopped due to %s. … Please resume your work and restart tasks as needed.`
(all **verified** as strings/changelog entries).

## 4. Model-facing surface (**verified** schemas)
| Tool | Schema |
|---|---|
| `manage_task` | `Action: list \| kill \| status \| send_input`; `TaskId` (required except `list`); `Input` (required for `send_input`). Description: *"Manage the background tasks of this conversation: 'list' the running tasks, check a task's 'status' and recent log output, 'send_input' to a running task, or 'kill' one. Refer to tasks by the TaskId that 'list' reports; keep task references human-readable when talking to the user."* — **outputs captured in §8** |
| `schedule` | see §3.4 |
| command tool | `Background`, `IsDaemon` (+ sandbox knobs: `BypassSandbox`, trusted-CLI handling) |

## 5. Prompt contract — templates located (**verified names**)
| Template | Content |
|---|---|
| `system_prompts/helpers/async_termination_rule.tmpl` | The A/B rule appended after any backgrounding: *"YOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: A) either proceed to other relevant work (if any) or, B) simply update the user with a short message … and end the turn. **DO NOTHING ELSE.**"* (5 occurrences = per-tool instantiations) |
| `system_prompts/messaging.tmpl` | **"Reactive Wakeup (No Polling Needed)"**: the system resumes execution when *a background task completes or sends a notification*, a subagent/peer message arrives, or a queued user message is ready — *"you do NOT need to poll in a loop"* |
| `system_prompts/{identity,guidelines,communication_style,artifacts,skills,plugins,slash_commands,planning_mode,planning_mode_artifacts,persistent_context,ephemeral_message,conversation_transcript,test_funcmap}` | the rest of the system prompt |
| `helpers/{errors,default_status_output_string}`, `step_strings/{run_command,send_command_input}` | result rendering (§3) |
| remote override keys `template__system_prompts__{messaging,guidelines,communication_style,planning_mode_artifacts}`, `template__spec_miner` | server-side A/B overrides — why some copy appears 3–5× |

## 6. What this design actually is
One abstraction with four orthogonal axes, applied everywhere:

| Axis | Mechanism |
|---|---|
| **out-channel** | `Notify()` → task notification into the conversation |
| **in-channel** | `Receive()/ReceiveCh()` → `send_input` steps, target = persistent terminal |
| **lifetime** | `WithIsDaemon` (outlives the task, resumes after restart) vs normal (killed with the pool) |
| **time** | `(*task).AfterFunc` → timers/crons, bounded by `MaxIterations`, early-cancelled by `TimerCondition` |
| **notice policy** | `WithSuppressCompletionNotification` (per task) |
| **gating** | `WithRequiresInputApproval` → step status `WAITING` → "Step is WAITING for user approval" |
| **ownership** | `ctxWithTask` — nested work inherits the task; `waiting_for_dependents` state |

Consequence: shell commands, tool calls, MCP calls, subagents and timers all appear in the same
`/tasks` panel and obey the same notification rules. Nothing is shell-special-cased.

## 7. Gaps in *this* document
- **Completion-notification body** — resolved by the capture (§3.5, §8.6).
- **Approval-prompt UI copy** — the model-side string is captured (`WAITING` → "Step is WAITING for
  user approval"); the human-facing prompt is a CLI view, not in the string table.
- **`Receive()` transport** — structured input is verified; whether the shell side is a PTY,
  a pipe, or a persistent terminal process is not.
- **Pool limits** — no `background.With*` options found ⇒ concurrency cap likely fixed/hardcoded.
- **Dependency graph** — `waiting_for_dependents` exists as a state; the parent/child bookkeeping
  is not decoded (`ActiveAgentTaskStepIndicesByDaemon` is the closest hint).
- **Daemon persistence** — no task tables in the SQLite strings; resumption logic likely lives in
  the CLI/conversation layer.

## 8. Empirical capture — `agy` v1.2.13, run 2026-09-29

Ran the real CLI in print mode and drove the whole loop. Raw NDJSON: `/tmp/agy-capture.jsonl`
(script: `~/.pi/agent/brain/agy-capture/capture.py`).

**Invocation** (`-p` swallows the *next* argument as its prompt, so the prompt must be attached):
```bash
agy --print='<prompt>' --output-format stream-json --dangerously-skip-permissions --print-timeout 150s
```

### 8.1 Backgrounded `run_command` result (verbatim)
````
(Launch tick loop in background)

```text
Created At: 2026-09-29T18:15:00+07:00
Tool is running as a background task with task id: 18af84bb-6c4c-4cab-956f-2cee58f9889a/task-2
Task logs are available at: file:///home/hj/.gemini/antigravity-cli/brain/18af84bb-6c4c-4cab-956f-2cee58f9889a/.system_generated/tasks/task-2.log
YOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: … DO NOTHING ELSE.
```
````
Note: the *result* carries the A/B rule; the log URI is a `file://` URL into
`…/brain/<conv>/.system_generated/tasks/task-N.log`.

### 8.2 `manage_task` Action="list" (verbatim)
```
You have 1 background task(s) currently running:
{
  "taskId": "18af84bb-6c4c-4cab-956f-2cee58f9889a/task-2",
  "toolName": "run_command",
  "toolSummary": "Tick loop",
  "description": "for i in $(seq 1 30); do echo tick $i; sleep 1; done",
  "startTime": "2026-09-29T11:15:00.818922869Z",
  "stepIndex": 2,
  "logUri": "file:///…/.system_generated/tasks/task-2.log"
}
```
Task ids are `<conversation-uuid>/task-N` (matches `ParseLocalTaskID`); each task is tied to the
**step** that created it (`stepIndex`).

### 8.3 `manage_task` Action="status" (verbatim)
```
Task: 18af84bb-6c4c-4cab-956f-2cee58f9889a/task-2
Status: RUNNING
Log: /home/hj/.gemini/antigravity-cli/brain/18af84bb-6c4c-4cab-956f-2cee58f9889a/.system_generated/tasks/task-2.log
Log output:
tick 1
tick 2
tick 3
```

### 8.4 `manage_task` Action="send_input" (verbatim)
```
Input sent to task "18af84bb-6c4c-4cab-956f-2cee58f9889a/task-2".
```
(The `send_command_input.tmpl` template in §3.3 is the *step* rendering; the tool result is this
plainer line.)

### 8.5 `manage_task` Action="kill" (verbatim)
```
Task "18af84bb-6c4c-4cab-956f-2cee58f9889a/task-2" cancelled.
```

### 8.6 Completion notification (verbatim, §3.5)
Captured in full — a `priority=MESSAGE_PRIORITY_HIGH` `<SYSTEM_MESSAGE>` whose body is the step
result renderer (exit code, stdout, stderr, `file://` log URI), wrapped in the explicit
"not actually sent by the user" preamble.

### 8.7 Stream event shape
```
{"event":"step_update","step_update":{"conversation_id":"…","step_index":14,"state":"ACTIVE",
   "step_type":"agent_response","text_delta":"…","duration_seconds":8.58,
   "usage":{"input_tokens":2062,…}}}
{"event":"result","result":{"conversation_id":"…","status":"SUCCESS","response":"…"}}
```
Steps carry `state` (`ACTIVE`/`DONE`) and timing/usage — i.e. the harness-level view of the same
task lifecycle.

## 9. Remaining gaps after the capture
- **`Receive()` transport** — input is verified end-to-end through the CLI, but whether the shell
  side is a PTY, a pipe, or a persistent terminal process is still not observable from outside.
- **`requires_input_approval` prompt** — the model-side string is decoded (`WAITING` → "Step is
  WAITING for user approval"); the interactive approval UI text is not.
- **`waiting_for_dependents` / `waiting_for_message`** — states exist; the routing internals are not
  decoded.
- **Pool limits / daemon persistence** — no option symbols and no task tables found; likely fixed
  concurrency and CLI-layer resumption.

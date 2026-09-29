# Antigravity background tasks — reference

Research notes on how Google Antigravity handles long-running ("offloaded") tasks, kept
as the reference we design our own background-task behaviour from. Nothing here is our
design; that is section 7 onwards.

**Fetched:** 2026-09-29. Only three sources were read — one third-party tutorial for the
CLI surface, one Google API spec for the model underneath, and the product docs index.
Anything not attributed to a source is explicitly marked *inference*.

---

## 1. Sources

| # | Source | What it gives us |
|---|---|---|
| S1 | [Going Async: Background Tasks, Timers, and Scheduling in Antigravity CLI](https://www.narenvadapalli.com/blog/antigravity-cli-background-tasks/) — third-party walkthrough | The CLI's task surface: launch message, `/tasks` verbs, log location, timers/schedulers |
| S2 | [Background execution — Gemini API](https://ai.google.dev/gemini-api/docs/background-execution) — Google spec, "Last updated 2026-09-24" | The platform model: `background: true`, interaction states, client-side polling, streaming/resume, cancel/delete, chaining restriction |
| S3 | [Google Antigravity Docs](https://antigravity.google/docs/home?app=antigravity) — index | Asynchronous subagents; "delegate parallel background tasks to concurrent subagents without blocking your flow" |

Second pass — the questions in §8 sent us to Claude Code and Hermes Agent as well
(fetched 2026-09-29):

| # | Source | What it gives us |
|---|---|---|
| S4 | [Background Tasks & Monitoring — Claude Code](https://www.rugvailabs.com/tracks/track-claude-code/background-tasks-monitoring) | `run_in_background` completion notification shape; `Monitor` = pattern-matched notifications; `ScheduleWakeup` cache-window guidance; the four background patterns and their cost table |
| S5 | [Claude Code Background Tasks Guide (2026)](https://likeone.ai/blog/claude-code-background-tasks-guide-2026/) | Launch/read/stop triad (`run_in_background` · task output · task stop); where backgrounding is the *wrong* call |
| S6 | [Hermes Background Processes: Beginner's Guide](https://hermes-tutorials.dev/blog/hermes-background-processes-guide/) | `process` actions (`list poll wait log kill write submit close`); `notify_on_complete` vs `watch_patterns`; the notification policy enum; durability tiers |
| S7 | [Hermes Agent v0.8.0 — The Intelligence Release](https://hermes-agent-lab.com/releases/v0-8-0/) | "Background Task Auto-Notifications (`notify_on_complete`) — No More Polling"; inactivity-based timeouts (activity never killed, only idle) |
| S8 | [How to turn off Hermes background process notifications?](https://toolnavs.com/article/1762-how-to-turn-off-hermes-agent-background-process-notifications) | The `display.background_process_notifications` values and what each sends |
| S9 | [Antigravity: agent requires input for editing artifacts](https://discuss.ai.google.dev/t/antigravity-latest-version-requires-input-for-editing-artifacts/126338) | Field report: `requires_action` with nothing to approve **stalls the agent entirely** |

pi's own `docs/rpc-commands.md` settles the mid-turn delivery question (§8, Q3):

> `"steer"`: Queue the message while the agent is running. It is delivered after the current
> assistant turn finishes executing its tool calls, before the next LLM call.

| # | Source | What it gives us |
|---|---|---|
| S10 | The **`agy` binary itself** — `/home/hj/.local/bin/agy`, v1.2.13, sha256 `574b0234656c44564f3ff3b013225c86…` (see §10) | The real contract: tool description + schema, the system-prompt templates, and their own changelog admissions |

## 2. The launch contract

Quoted from S1 — this single message is the whole design in miniature:

> **Caveat (see §10):** this wording is **not present in the v1.2.13 binary** (`n=0` for all
> three fragments). Treat it as a third-party paraphrase, not literal text.

```
AGY> Start the local development server in the background.
🤖 Proposing command: npm run dev
[Review Required] Run command 'npm run dev'? (Y/n): y
Task started in background as task-50.
You can continue your session. I will notify you when the task output updates or completes.
```

Three promises, and all three matter:

1. **"You can continue your session"** — the agent is never blocked waiting.
2. **"I will notify you when the task output updates"** — notifications are *update-driven*,
   not completion-only.
3. **"…or completes"** — terminal events are included in the same channel.

## 3. Task surface (S1)

| Verb | Meaning |
|---|---|
| `/tasks list` | all active tasks |
| `/tasks status task-50` | a task's status **and logs** |
| `/tasks kill task-50` | stop a stuck task |
| `/tasks input task-50 "y"` | write stdin into the running task |

Logs stream continuously to a cache path:

```
~/.gemini/antigravity-cli/tasks/<id>.log
```

"meaning you can tail them or inspect them manually at any point" (S1) — reading the log is
possible, but it is the human/debug path, not the mechanism.

**Timers and schedulers (S1)** — bounded, cancellation-aware polling lives in the *client*:

```
AGY> Schedule a reminder in 10 minutes to run npm test on the main branch.
🤖 Timer set for 600 seconds.
```

- one-shot timers, with **conditional cancellation**: "Any Cancel" (cancel on any message) and
  "Task Specific: cancel the timer early if a specific background task (like task-50) completes";
- recurring cron jobs that run "as persistent background tasks as long as your terminal
  session is active", with a `MaxIterations` limit ("polling a server health endpoint every
  minute, but stopping after 5 attempts").

## 4. Platform model underneath (S2)

`background: true` on the Interactions API returns an interaction id immediately; the work
continues server-side:

```json
{ "model": "gemini-3.8-flash", "input": "…", "background": true }
```

States: `in_progress` · **`requires_action`** · `completed` · `failed` · `cancelled`, where
`requires_action` means the interaction **paused, "waiting for client input (such as
confirming a tool execution or answering a question)"**.

Retrieval — two patterns:

- **Polling (non-blocking)**, done by the *client*:
  ```python
  interaction = client.interactions.get(id="YOUR_INTERACTION_ID")
  while interaction.status == "in_progress":
      time.sleep(5)                 # ← the poll interval lives here, in the client
      interaction = client.interactions.get(id=interaction.id)
  ```
- **Streaming** with resume: each delta carries an `event_id`, and a dropped stream is
  reconnected with `last_event_id`.

Cancellation: `POST /interactions/{id}/cancel` → `cancelled`; `DELETE` removes the record.

One hard rule worth noting: **chaining a follow-up interaction onto one that is still
`in_progress` returns `400 Bad Request`** — you must wait for `completed` before continuing
that conversation.

## 5. Who polls whom (the part that answers our problem)

| | Antigravity | 
|---|---|
| who watches the task | the **client/session** — `sleep(5)` → `get(id)`, or the stream |
| what the model does | continues its own work; never issues the poll itself |
| where task information lands | as session events the model reads on its next generation |
| when the model is woken | when a notification arrives; an idle notification is a new interaction (a turn) |
| how often it can be woken | bounded by the client: coalescing, `MaxIterations`, conditional timer cancellation |

*Inference from S1+S2:* the model never spends a turn to check on a task, because checking is
not a model action at all. That is why several related jobs can run inside one task without
blocking and without the agent polling.

## 6. Gaps in the sources

Not covered by S1/S2, so unresolved rather than assumed:

- how often "output updates" actually notify (rate, coalescing window);
- what happens to a task that is **quiet by design** (a dev server produces no output but is
  healthy) — no mention of a silence policy at all;
- whether notifications interrupt an in-flight interaction or queue until it completes;
- cost/limit model for notification-driven turns.

---

# 7. What we take from it (our design, not theirs)

Derived from the above; this is the section to keep in sync with our implementation.

1. **Launch async, never block.** Crossing the hand-off budget promotes the job; the agent
   continues. No auto-attach — blocking would destroy the parallel-work property in S1's
   "you can continue your session". *(Ours is a fixed **15 s**, owned by the extension, not a tool
   parameter — see `antigravity-task-implementation.md` §10.1a for why and how it maps onto the port.)*
2. **The extension is the client.** It polls (a few seconds) exactly like S2's `sleep(5)`
   loop. The model never polls.
3. **Events are edge-triggered, never periodic.** Output resumed · entered silence · needs a
   decision · finished. Periodic pings are what S1's `MaxIterations` exists to bound; we bound
   it by construction instead.
4. **Delivery depends on who is listening.** Mid-turn → inject into the turn already running
   (rides a model call the agent was making anyway, so ~free). Idle → steer, and only for
   terminal events or `requires_action`.
5. **`requires_action` parity.** A job that looks like it is waiting on a prompt, or that has
   been silent past the long threshold, emits one decision event. The answer is
   `job_decide keep | kill | check`, and `keep` suppresses that silence episode (fresh output
   re-arms it) — the equivalent of S1's "cancel the timer early if the task completes".
6. **Pull verbs mirror S1's surface.** `jobs list` ≈ `/tasks list`, `jobs output` ≈
   `/tasks status`, `jobs kill` ≈ `/tasks kill`, `job_decide` ≈ the answer to
   `requires_action`. Reading `/tmp/pi-bg/<id>.log` directly is the human/debug path, exactly
   as S1 frames its cache file.
7. **Persistence.** S1's cron jobs run "as long as your terminal session is active"; ours must
   survive more than that — jobs are recorded in the runtime file, restored from the session
   snapshot, and orphans from a dead pi are reaped on the next start.

## 8. The five questions, settled

### Q1 — Silence policy for service-like jobs

| | behaviour |
|---|---|
| Antigravity | nothing in S1/S2 — silence simply isn't a signal |
| Claude Code | **never notifies on silence.** Two channels only: a completion notification, or `Monitor` watching a **pattern** the agent chose (`pattern="FAILED|ERROR"`) |
| Hermes | silence isn't an event either; instead timeouts became **inactivity-based** — "long-running tasks that are actively producing output … will never be terminated. Only truly idle agents time out" (S7) |

**Decision:** drop the 60 s quiet ping from the default path. Silence is a reason **not to kill** a
job, not a reason to speak. Watching becomes opt-in (a pattern, or the long threshold) and is
one-shot per silence episode; a healthy dev server then costs **zero** messages.

### Q2 — Update-event rate

| | behaviour |
|---|---|
| Claude Code | `Monitor` fires "each time the pattern matches" — "Cheap — only fires on match", and **no token cost during the wait** |
| Hermes | `watch_patterns` is **rate-limited to one notification per 15 s per process** and **auto-disabled after three consecutive dropped windows** |

**Decision:** default to **completion-only**. If update watching is enabled: 1 per 15 s per job,
self-disable after 3 dropped windows. Pattern matching is what makes an update meaningful; raw
"output changed" is not.

### Q3 — Can pi's steer land mid-turn?

**Yes — settled by pi's own docs, not the web:** `steer` is queued while the agent runs and is
delivered *after the current assistant turn finishes its tool calls, before the next LLM call*.
So a mid-turn event rides an LLM call the agent was already going to make — it does **not** spawn
a separate run. Two consequences: (a) the cost argument for mid-turn injection holds; (b) the
steering mode matters for coalescing (`one-at-a-time` delivers queued steers singly,
`all` delivers them together).

### Q4 — Does the hand-off seed the first update?

No. Claude Code returns a process handle and the notice arrives **at completion**, with output
truncated and the full text reachable via Read. Hermes' default policy is `concise` = a one-line
status **on completion**. **Decision:** hand-off stays purely informational; no seeded update.

### Q5 — Do we need a `MaxIterations` analog?

| | behaviour |
|---|---|
| Antigravity | `MaxIterations` caps recurring cron jobs ("stopping after 5 attempts") |
| Claude Code | no iteration cap — instead wake-ups are priced by the **prompt-cache TTL**: `<270 s` stays cache-warm (cheap), `>1200 s` amortises one cache miss; idle ticks default `1200–1800 s` |
| Hermes | rate limit + auto-disable, plus a **policy enum** `display.background_process_notifications` = `concise` \| `all` \| `result` \| `error` \| `off` |

**Decision:** budget forced wakes per job — **1 terminal + at most 1 decision** — align any deferred
check with the cache window (<270 s or >1200 s, never ~300 s), and expose the same kind of policy
knob (`all | concise | result | error | off`).

## 9. Cross-cutting lessons

- **Durability is tiered and must be stated** (S6): terminal background = *session-scoped*,
cronjob = *survives restarts*, delegation = *not durable* ("a restart leaves child tasks
unknown"). Sessions with active background processes are **never auto-reset**. Ours: runtime
record + session snapshot + orphan reaper on the next start.
- **Never emit a decision without a resolving path** (S9): Antigravity agents that hit
`requires_action` with "nothing to approve" stall completely. Every decision event must carry
`job_decide keep | kill | check`, and `keep` must actually silence that episode.
- **Backgrounding is not always right** (S5): if the next step depends on the result, running
synchronously is correct even when slow. The background path is for work that genuinely runs
*alongside* the next steps.
- **Read output on demand, stop explicitly** (S5): abandoned background servers are the named
failure mode; the pull verbs (`jobs list | output | kill`) exist for exactly that.

---

# 10. Decoded from the `agy` binary (primary source)

**Provenance.** `/home/hj/.local/bin/agy`, 220 MB Go binary, **v1.2.13**,
sha256 `574b0234656c44564f3ff3b013225c86…`. Method: `strings`/`grep -Fbo` over the binary; every
quote below was re-confirmed with an occurrence count. This is the strongest source we have —
the contract as *shipped*, not as documented.

Each quote is tagged **[verified in binary]** (never fetched from a web page). Counts in
parentheses are occurrences of the exact fragment.

## 10.1 The tool contract the model is given

Tool description **(1)**:

> Manage the background tasks of this conversation: 'list' the running tasks, check a task's
> 'status' and recent log output, 'send_input' to a running task, or 'kill' one. Refer to tasks
> by the TaskId that 'list' reports; keep task references human-readable when talking to the user.

A second wording **(1)**:

> Manage background tasks. Use this tool to list running tasks or interact with tasks that were
> sent to the background.

Schema, from the embedded `jsonschema` tags **(5)**:

```
Action : required, enum=list, enum=kill, enum=status, enum=send_input
         "'list' reports the running tasks; the other actions operate on the task named in TaskId."
TaskId : "Task to manage, as reported by 'list'. Required for 'kill', 'status' and 'send_input'."
Input  : "Input to deliver to the task. Required for 'send_input'."
```

So the model-facing surface is exactly: **list · status · send_input · kill** — the same four
verbs we get from `jobs list | output | attach | kill` plus `job_decide`.

## 10.2 The system-prompt templates (the part that makes behaviour deterministic)

**Reactive Wakeup (No Polling Needed)** **(3)** — template with `%s` placeholders; it sits next
to the messaging template (`You are connected to a messaging system where you may receive
messages from: %s.`), i.e. it is injected into the system prompt:

> ## Reactive Wakeup (No Polling Needed)
>
> The system automatically resumes your execution when:
> %s
> This means you do **NOT** need to poll in a loop while waiting for messages or updates. %s
> The system will notify you when there is something to process.

**The rule appended after any backgrounding command** **(5)** — its neighbour string describes it:
*"This helper template appends async termination guidance for background tasks (e.g. run_command)."*

> After launching a background task such as 'run_command', YOU MUST TAKE ONE OF THE FOLLOWING TWO
> ACTIONS:
> A) either proceed to other relevant work (if any) or,
> B) simply update the user with a short message (e.g. 'task-20 has been launched in the
> background. I will wait for it to complete before proceeding.') and end the turn.
> DO NOTHING ELSE.

**Schedule tool** **(1 each)** — "never use a shell sleep command as a timer":

> Schedule a one-shot timer (DurationSeconds) or a recurring cron job (CronExpression) that
> notifies you via Prompt. This tool call runs as a background task and returns immediately; end
> your turn (call no more tools) to wait for notifications. … never use a shell sleep command as a
> timer.

Cron parameters **(3)**: `MaxIterations` to cap triggers, `IsDaemon` ("leave false (default) if
polling/monitoring task progress; set true only for independent standing jobs"), and
`TimerCondition` = `never` (default) | `any` | a sender id — early cancel on message, **max one
active early-termination timer**.

## 10.3 Their own changelog, embedded in the same binary

The decisive line **(1)**:

> Improved the agent's behavior after backgrounding work by **removing the anti-polling reminder
> text from the `manage_task` and `manage_inbox` tool results, which could itself nudge the model
> into a polling loop.**

Others worth knowing **(1 each)**:

- `root agent idle; waiting up to %s for %d background task(s)` — the harness waits when idle; the
  model does not. A `"fullyIdle": true // true if all background tasks are done` flag exists too.
- `terminating %d background task(s) and %d daemon task(s) on exit` — normal vs daemon lifetime.
- Headless runs "wait for background tasks until the `--print-timeout` deadline, up to a 30-minute
  cap" and "leave daemon background tasks such as dev servers running".
- `The source conversation's background tasks were not branched with it; they keep running there.`
- `[Notice] All your background tasks have been stopped due to %s. … Please resume your work and
  restart tasks as needed.`
- A deadlock they had to fix: "a coordinator waiting on active subagents or background tasks would
  loop injecting empty continue steps until it hit the invocation limit, **wasting tokens**".
- `send_message should not be used to provide input to tasks; use the manage_task tool with action
  'send_input' instead` — stdin goes through the task tool, not the message bus.
- Status UI: "Show active subagents and background tasks below the input box", each capped to a
  single line.

## 10.4 Correction to §2

S1's quoted launch message — *"I will notify you when the task output updates or completes"*,
*"Task started in background as task-50"* — returns **0 hits** in v1.2.13. It is a third-party
paraphrase (or an older build), and §2 is now marked accordingly. The behaviour it describes is
real, but it is *stated* to the model as §10.2's templates, not as that sentence.

## 10.5 What this changes for us

1. **Put the loop in the prompt, not in tool results.** Their changelog says the anti-poll nudge in
   tool output *caused* polling — so our `v1.6.44` line ("Do NOT poll the log…") is that exact
   mistake. The contract belongs in the tool descriptions / system guidance.
2. **Adopt the A/B rule verbatim.** After backgrounding: (A) do other relevant work, or (B) say one
   short line and end the turn. "DO NOTHING ELSE." That is the deterministic behaviour we lack.
3. **Publish the promise alongside it** — "Reactive Wakeup (No Polling Needed)": the system resumes
   the agent when a task completes or notifies. The rule is only safe because the promise exists.
4. **Keep anti-poll text out of `jobs output` / notices**; if guidance is needed, it goes in the tool
   description (read once) rather than in every result (read every call).

## 10.6 Open questions this decode does *not* answer

- **Silence policy** — still nothing about quiet-but-healthy jobs (§8 Q1 stands: silence is not an
  event, and it never kills).
- **Update-notification rate** — the binary shows `manage_task` "status + recent log output" as a
  *pull* verb; no rate/coalescing constant was found for pushed updates.
- **What exactly triggers a wake** — the template lists causes (task completes, task sends a
  notification, subagent message, queued user message); the notification *emission* rules are not
  in the string table.

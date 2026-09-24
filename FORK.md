# Fork notes

Personal fork of [`patty-io/pi-patty-bg-tasks`](https://github.com/patty-io/pi-patty-bg-tasks),
MIT licensed. All credit for the extension belongs upstream.

## Base

| | |
|---|---|
| Upstream repo | `github.com/patty-io/pi-patty-bg-tasks` |
| Base commit | `6676db5` — `fix(timeout): silent backgrounding — no forced job_decide turn — v1.1.6` |
| Base version | `1.1.6` (the latest published npm release) |
| Why not `main` | `main` is an unreleased `2.0.0` breaking re-architecture: 48 files, ±1900 lines. It does not change the 120s constant, so it buys nothing here and would drag in unvetted churn. |

Upstream publishes **no git tags**, so this fork's pin is the commit SHA above plus
its own local tag (see below).

## The only functional change

`src/types.ts` — the auto-background threshold:

```diff
-// --- Configuration constants ---
-export const DEFAULT_TIMEOUT_MS = 120_000;
+// --- Configuration constants ---
+// Override with PI_PATTY_BG_TIMEOUT_MS. Defaults to 15s to match Claude Code's
+// assistant blocking budget (ASSISTANT_BLOCKING_BUDGET_MS = 15_000).
+const ENV_TIMEOUT_MS = Number(process.env.PI_PATTY_BG_TIMEOUT_MS);
+export const DEFAULT_TIMEOUT_MS =
+  Number.isFinite(ENV_TIMEOUT_MS) && ENV_TIMEOUT_MS > 0 ? ENV_TIMEOUT_MS : 15_000;
```

### Why 15s

Claude Code runs **two separate clocks**, and upstream patty collapsed them into one:

| Clock | Value | Role |
|---|---|---|
| `ASSISTANT_BLOCKING_BUDGET_MS` | `15_000` | *"blocking commands are automatically backgrounded after 15 seconds"* — the actual auto-background trigger |
| `BASH_DEFAULT_TIMEOUT_MS` | `120_000` | The kill timeout when no explicit `timeout` is passed |
| `BASH_MAX_TIMEOUT_MS` | `600_000` | Ceiling on a requested timeout |

Upstream's own changelog reads: *"Default auto-background timeout is now 120s
**(was 15s)**, matching Claude Code."* Reverting to 15s restores patty's original
behavior and matches the clock that actually matters.

Non-functional changes: `package.json` version → `1.1.6-pi15`, a README fork notice,
and this file.

## Environment override

```sh
PI_PATTY_BG_TIMEOUT_MS=10000 pi    # 10s
PI_PATTY_BG_TIMEOUT_MS=30000 pi    # 30s
```

Unset or non-positive values fall back to 15s.

## Install

```sh
pi install git:github.com/tomkhoailang/pi-patty-bg-tasks@v1.1.6-pi15
```

## Rebase onto a newer upstream release

```sh
git clone https://github.com/tomkhoailang/pi-patty-bg-tasks.git
cd pi-patty-bg-tasks
git remote add upstream https://github.com/patty-io/pi-patty-bg-tasks.git
git fetch upstream
git rebase <new-upstream-commit>

# Re-apply the constant change if the rebase conflicts, then:
node -e "const s=require('fs').readFileSync('src/types.ts','utf8'); \
  if(!/PI_PATTY_BG_TIMEOUT_MS/.test(s)) throw new Error('threshold patch lost in rebase');" \
  && echo "threshold patch intact"

git push --force-with-lease origin main
git tag -f v<new-version>-pi15 && git push -f origin v<new-version>-pi15
```

Then update the pinned ref in `setup_pi_agent.sh` (`BACKGROUND_TASKS_SRC`) and
`pi-settings.json`.

Note: Pi does not `git pull` packages. Git sources are pinned; reconcile with
`pi update --extensions`, or just re-run `setup_pi_agent.sh`.

## Upstreaming

If upstream ever adds a configurable auto-background timeout, this fork can be
retired. A one-line issue requesting it is the cheapest path.

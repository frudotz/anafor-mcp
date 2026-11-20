🇹🇷 Türkçe: [kullanim.md](../kullanim.md)

# Anafor user guide

`anafor permissions [--days N] [--json]` summarizes `.anafor/metrics/permissions.jsonl` by session/day, tool, and reason. Narrow allow suggestions derived from Bash calls are displayed for review only; settings are never changed. `anafor doctor` shows the last seven days' total.

Anafor is an orchestration MCP server for frontier AI models: a manager agent plans work, dispatches it to workers, reviews results, and accepts them. You can configure which models take which roles. The manager does not edit code files itself; this rule is enforced by a hook.

## 1. Installation

```bash
git clone https://github.com/frudotz/anafor-mcp
cd anafor-mcp && npm install && npm run build
```

Requirements: Node 24+, git, Claude Code and at least one worker:

For medium-sized jobs where quality matters, a direct single-agent Opus run gave better results (F32); Anafor is for large parallel jobs, Claude-limit bottlenecks, and governed workflows.

- Codex CLI (`codex login`)
- Claude Code itself (no extra setup needed for the `cirak` worker)

## 2. Connecting a project to Anafor

```bash
cd /your-project                   # a git repository with at least one commit
node /path/anafor-mcp/dist/cli/main.js init      # .anafor/, policy.json, .gitignore, .mcp.json
node /path/anafor-mcp/dist/cli/main.js init --exclude-local  # add .anafor/ to the common git info/exclude
node /path/anafor-mcp/dist/cli/main.js doctor    # node, git, sqlite, workers
claude --plugin-dir /path/anafor-mcp/plugin      # manager hooks + /anafor:* commands
```

> If you use `--plugin-dir`, `.mcp.json` is not needed; the plugin brings its own MCP server. If you only want MCP (without hooks), plain `claude` is enough.

## 2b. Terminal CLI mode (talking to the brain agent)

Without opening Claude Code, you can talk to the brain agent from Anafor's own terminal:

```bash
cd /your-project
anafor chat                 # persistent session (.anafor/brain.json); --new to start fresh
anafor run "goal"           # headless, lean brain session
anafor chat --once "Summarize open tasks"     # single message, non-interactive
anafor jobs [--all]         # task and job board
anafor watch                # live job events
anafor roles                # brain and worker roles
anafor roles set review codex,local,cirak
anafor limits               # worker session/usage limits
```

- `anafor chat` launches the official `claude` binary with user settings. `anafor run` and `anafor loop` default to lean mode, loading only the Anafor MCP server and `Read`, `Grep`, `Glob`, and `Bash`; other MCP servers, skills, and slash commands are disabled.
- In chat, brain messages, the tools it calls (`⚙`) and worker events (`↳`) appear **live**. In-chat commands: `/jobs`, `/limits`, `/izinler`, `/cikis`.
- **Permissions:** when a tool that is not pre-approved is needed (e.g. `npm test`), the brain asks you through the `permission_prompt` tool: `[e]vet / [h]ayır / [d]aima` (yes / no / always). If no answer arrives, the request is denied. In `--once` mode requests are denied automatically. The permission mode from your Claude Code settings (e.g. `auto`) applies; to change it use `--permission-mode manual`.
- The session persists: each run of `anafor chat` continues the same brain session.

Headless brain settings live in the `brain` object in `anafor.config.json`. `lean` defaults to `true`; set it to `false` for the previous plugin behavior. `model` and `effort` are optional. `anafor run --model MODEL` and loop's `--model MODEL` override the configured model.

```json
{ "brain": { "lean": true, "model": "claude-sonnet-4-5", "effort": "medium" } }
```

### Headless mode

```bash
anafor run "Add clear() to the Stack class and write a test for it" --accept --merge --worker codex
```

The brain carries out the goal end to end without a user: plan → dispatch → review → (optional) accept → evidence → authorization → merge → audit → cleanup. Anything that requests permission is denied. Without `--accept` nothing is accepted; without `--merge` nothing is merged. No Agent SDK is required; the official `claude` binary is used.

### Development loop (`anafor loop`)

The loop opens one brain session through the official `claude` binary. Each turn
prompts the manager with the goal or next backlog item; an `ANAFOR_LOOP` marker
reports completion, continuation, or a blocker. As limits approach, it asks the
brain to bring current work to a safe point instead of starting large work.

```bash
anafor loop start "goal" [--auto-resume] [--max-cycles N] [--until ISO]
anafor loop start --backlog backlog.md [--profile saver|balanced|quality]
anafor loop status
anafor loop pause | resume | stop
```

Other start flags: `--accept`, `--merge`, `--model M`; `--detach` starts the loop
in a detached process. Acceptance and merging are disabled unless `--accept` and
`--merge` are explicitly set. MCP `loop_start` accepts a goal or backlog with the
same options; `loop_status` reports state and backlog progress; `loop_stop` pauses
or stops. In Claude Code, `/anafor:loop <goal>` also calls `loop_start`.

Optional shutdown can be enabled with `anafor loop start "goal" --shutdown-on-finish`
or `shutdown_on_finish: true` on `loop_start`; it is off by default. You can also
set `"loop": { "on_finish": "shutdown" }` in `anafor.config.json`. Only DONE/BLOCKED
waits for active Anafor jobs (up to 30 minutes), then schedules shutdown in 120
seconds. Unsaved data in other applications may be lost. Cancel with `shutdown /a`
on Windows or `shutdown -c` on macOS/Linux.
During the wait, `anafor loop stop` or `anafor loop pause` cancels shutdown. If
shutdown is already scheduled, either command tries the operating system cancel command.

Limit thresholds come from `limits.brain` in `anafor.config.json`: defaults are
`warn_at: 75`, `pause_at: 90`, and `pause_at_weekly: 95` (percent). At a pause
threshold, the loop stops after its turn, creates a checkpoint, and records
`resume_at`. `--auto-resume` is the user's choice; without it the loop stays paused.
Resume manually with `anafor loop resume`. A `pause` or `stop` request takes effect
after the current turn completes.

The backlog path is relative to the project root; items use `- [ ] item` lines:

```markdown
- [ ] Review the account registration flow
- [ ] Add tests and verify the result
```

The brain's final response for each turn must include one marker:
`ANAFOR_LOOP: DONE`, `ANAFOR_LOOP: CONTINUE`, or `ANAFOR_LOOP: BLOCKED <reason>`.
The statusline shows a running loop as `↻ loop #N`, an auto-resuming pause as
`⏸ loop: resumes at <time>`, and a manual pause as
`⏸ loop paused: anafor loop resume`. The UserPromptSubmit hook adds a short safe
point reminder when Claude usage exceeds the warning threshold.

Recommendation: document next steps in advance in a note, checkpoint, or backlog
file. The loop respects provider limits and never bypasses them; it does not run
parallel brains, keeps one brain session, and uses the official `claude` binary.
This is not legal advice; check providers' current terms separately.

## 3. Daily flow

| Step | Command or tool |
|---|---|
| Plan | `/anafor:plan <goal>`: analysis → tasks + acceptance criteria → approval |
| Dispatch | `/anafor:run`: `job_dispatch` → background `anafor job wait <id>` for long jobs → `job_result` / `job_diff` |

For long waits, start `anafor job wait <id>` with Claude Code Bash `run_in_background`; the harness wakes the director when it finishes. MCP `job_wait` is for short checks of at most 50 seconds.
| Fix | `job_request_changes` (same worker session, at most 5 per task) |
| Accept | `/anafor:accept <task> <job>`: `task_accept` gates; standard/deep tasks require a current independent review. Medium or higher findings or missing acceptance criteria block acceptance until a correction after review passes `auto_check`. Low/info findings are returned in `open_low_findings`. If the worker could not run tests (e.g. sandbox): `evidence_generate` → `task_accept` + `verified_by_evidence_reason` |
| Bring into your branch | `task_merge`: task branch → branch of the working tree (clean tree required) |
| Clean up | `workspace_cleanup` |
| Status | `/anafor:status` |

### Job states

`queued → starting → running → validating → needs_review → approved → merged`

Error states: `failed`, `timed_out`, `cancelled`, `invalid_output` (the worker produced output that does not match the schema).

If the server restarts, dead jobs become `failed (orphaned)`. **No job is ever re-run automatically.**

## 4. Manager discipline

- Claude editing code files in an Anafor project with `Edit`/`Write`, and file-modifying shell commands, are **blocked**. The reason is passed to Claude and written to `.anafor/audit/interventions.jsonl`.
- Allowed: reading, tests, builds, git/gh management commands, `*.md`, `docs/`, `lat.md/`.
- **Snag exception (intervention):** `intervene` (reason + paths + at most 30 min) → edit → `intervene_end` (summary). Everything is audited.
- **Task takeover:** if workers fail repeatedly (default: 3 failed or rejected jobs), the task becomes `blocked`, or a job runs longer than 60 minutes, Claude takes over the task with `task_takeover`. Active jobs are cancelled; Claude works only in that task's worktree, with time-limited permission. When done: `takeover_complete` → `task_accept`. Thresholds: `anafor.config.json` → `"escalation": { "failure_threshold": 3, "stall_minutes": 60, "takeover_minutes": 120 }`.
- Worker worktrees (`.anafor/worktrees/`) cannot be opened by any `allow_paths` rule; they can only be edited with permission.
- Mode: `anafor.config.json` → `"director_mode": "enforce" | "warn" | "off"`.

## 5. Configuration (`anafor.config.json`)

```json
{
  "director_mode": "enforce",
  "allow_paths": ["lat.md/**", "docs/**", "**/*.md"],
  "default_worker": "codex",
  "routing_mode": "static",
  "worktree_setup": "npm ci",
  "worktree_cache": { "paths": ["node_modules"], "key_files": ["package-lock.json"] },
  "routing": {
    "implementation": ["codex", "cirak"],
    "test": ["cirak", "codex"],
    "analysis": ["cirak", "codex"],
    "review": ["codex", "cirak"]
  },
  "workers": {
    "codex": { "max_concurrency": 2, "windows_sandbox": "elevated" },
    "cirak": { "model": "haiku", "max_concurrency": 3 },
    "fake": { "enabled": false }
  }
}
```

In a new worktree, `worktree_cache` replicates the dependency directory from the main working tree via **hardlinks** instead of running `worktree_setup`. Conditions: the `key_files` (e.g. `package-lock.json`) must be byte-identical in both trees, the directory must be gitignored, and the source must contain no symlinks/junctions. If a condition is not met, the reason is written to the event log and the normal `worktree_setup` runs. Junctions are not used, because `git worktree remove` deletes a junction's target (the main project's `node_modules`).

`max_parallel_jobs` (default 4) is the total number of jobs that may run at the same time **machine-wide**: all workers and all projects count. Each running runner leaves a lease with its process ID under `~/.anafor/running/`; leases of dead processes are not counted. When the limit is full, `job_dispatch` returns `LIMIT_REACHED`. Current usage is shown in the `project_status.parallel` field. A per-worker limit is set separately with `workers.<id>.max_concurrency`.

`.anafor/config.json` is for local overrides (not committed). The project file takes precedence.

### Worker CLI config isolation

Codex defaults to `workers.codex.user_config: "isolate"`. It starts with `--ignore-user-config`; only `model` (when there is no custom provider), `model_reasoning_effort`, and Windows `sandbox` are copied from `~/.codex/config.toml` (or `CODEX_HOME`). Job model/effort and `workers.codex.windows_sandbox` take precedence. Personal MCP servers, plugins, and project settings are not passed through. Web search, app connectors, and image generation are disabled in isolation. The user's `sandbox_workspace_write.network_access` setting is also not copied; sandbox network access is off by default. Use Codex `inherit` when a worker needs these settings or network access. In a measurement with codex-cli 0.167.2, first-turn input tokens fell by about 22% (16.8K → 13.1K) when app connectors, image generation, and web search were disabled; ignoring user config alone made no measurable difference.

cirak uses `--disable-slash-commands` to disable slash commands/skills and `--strict-mcp-config` to keep external MCP configuration out. User hooks and other Claude Code settings remain active. `workers["cirak"].user_config: "inherit"` only removes the slash-command disabling flag; strict MCP configuration remains enabled.

To deliberately inherit the personal CLI configuration, set `"user_config": "inherit"` for that worker, for example `"workers": { "codex": { "user_config": "inherit" } }`. This removes Codex user-config isolation or cirak's slash-command disabling flag, respectively.

`routing_mode` stays `static` by default and uses the `routing` list as is. With `adaptive`, workers that have at least three finished jobs in the same role are moved ahead by acceptance rate; those with less history keep their position in the list. The `worker_stats` MCP tool (with an optional `role` filter) shows acceptance, failure, change requests, duration and token averages.

## 6. Governance (commit, push, merge, deploy)

1. `checkpoint`: records the git state. Does not modify the working tree.
2. `operation_authorize`: `.anafor/policy.json` + evidence files + checkpoint freshness. Write evidence under **`.anafor/evidence/`** (inside the project, not in git, allowed by the hook).
   - Default policy: autonomous commit enabled; push, PR, merge and deploy allowlists are **empty** (denied); production disabled.
   - Protected risks (production data loss, irreversible change, security/access policy, unplanned cost) **always** require explicit user approval and evidence.
3. Perform the operation with the project's normal tools.
4. `operation_record`: every successful, failed and blocked attempt is written to the append-only `.anafor/audit/operations.jsonl`.

No destructive automatic recovery (`reset --hard`, force push, mass deletion) is performed. Rollback is done with `git revert`.

## 7. Project memory (Lat.md, optional)

- **Automatic context:** if the project has `lat.md/`, task-relevant sections are added to each new job's brief ("Project memory"). Selection is done with `lat search` (offline hybrid search, at most 4 sections, ~4000 characters). If `lat` is not installed, a built-in keyword search is used. Not added for fix-up and follow-up jobs, because that session already has the context. To disable: `"memory_context": false`. A `memory` event and a `memory_metrics` record appear in the event log.

- `memory_lock acquire` → update `lat.md/` → `lat check` → `memory_lock release` (with the token). The lease does not expire on its own.
- `memory_metrics`: short masked label. Token counts are written only when the worker or CLI reports real values.

## 7b. Session and usage limits

```bash
node /path/anafor-mcp/dist/cli/main.js limits
# codex        ok       5s %10 (Sal 01:55) · 7g %38 (Cmt 19:49)
# claude       warning  5s %84 · 7g %26
```

MCP tool: `workers_limits`. Sources (only information the official tools provide themselves; credentials are never touched):

| Worker | Source |
|---|---|
| Codex | read-only `account/rateLimits/read` via `codex app-server`, with rollout files as fallback. `anafor limits --refresh` refreshes live; the statusline refreshes its cache in the background at most every five minutes. |
| Claude (brain and cirak) | `rate_limit_event` from `cirak` jobs + Claude Code statusline input |
| Antigravity, OpenCode, local | The tool does not report limits → `unknown` |

To also see the brain session's limits, add this to your Claude Code settings (`~/.claude/settings.json`):

```json
{ "statusLine": { "type": "command", "command": "node /path/anafor-mcp/dist/cli/main.js statusline" } }
```

The statusline reads Codex limits from cache. Observations older than 30 minutes are dimmed and those older than 24 hours are hidden. The default worker list is `codex`; set `"statusline": { "workers": [] }` in `anafor.config.json` to disable worker limits, or add other workers with cached limits.

The router skips a worker whose window is 100% full (and not yet reset).

## 7c. Capacity model and role assignment recommendation

`anafor capacity` shows each account (claude, codex …) with its limit windows.

**CP (capacity points)** is 1% of a window. Free space is computed as `100 − usage − reserve`. The reserve is the share kept for your own interactive use; by default it is 10% of the 5-hour window and 15% of the weekly window.

**Pace** is the usage ratio divided by the ratio of elapsed time in the window. A pace above 1 means the window will fill up before it ends.

**How is per-job cost learned?** When a job finishes while no other job is running on the same account, the runner compares the window's usage before and after the job. The difference is recorded in `~/.anafor/capacity-costs.json` for that account, role and window. Planning uses the p80 of these measurements. From this, a per-role "~N jobs left" estimate is derived.

Note: the brain and `cirak` share the Claude account. Therefore the costs computed for Claude are an upper bound.

**Hints:** `anafor capacity` warns when a window reaches its reserve, is depleting fast, or a role has capacity for 2 or fewer jobs left. If a role's first worker is constrained, it suggests a healthy fallback and gives the `anafor roles set …` command to apply it. The same information is available via the `capacity_status` MCP tool.

**The recommended role assignment** is generated from a periodic meta profile (2026-Q4, the F19 research in the vault). Example:

```bash
anafor capacity recommend claude-max,chatgpt-plus          # show the recommendation
anafor capacity recommend claude-max,chatgpt-plus --apply  # anafor.config.json → subscriptions + routing
anafor capacity recommend                                  # list of subscription IDs
```

Principles behind the recommendation:
- The brain runs on the frontier tier (Opus).
- At equal tier, a worker that does not share the brain's account is preferred.
- Review is given to a different model family than the implementer.
- Local models are used only as a fallback for tests and analysis.
- Subscription-based workers are shown with a provider-terms warning.

Settings (`anafor.config.json`):

```json
{
  "subscriptions": ["claude-max", "chatgpt-plus"],
  "capacity": { "reserve_five_hour": 10, "reserve_weekly": 15, "pace_threshold": 1.2 }
}
```

### Load balancer

The router reorders the role's preference chain (`routing`) **according to subscription capacity**. The order in the chain expresses quality preference. The balancer changes this order only to push constrained accounts back.

| Strategy | Behavior |
|---|---|
| `balanced` (default) | Accounts that have reached their reserve or whose estimated job cost does not fit in free space go to the end; fast-depleting ones go to the middle. Accounts not yet observed are treated as neutral. |
| `protect-brain` | `balanced` + within an equal group, workers using the brain's Claude account are moved back. |
| `cheap-first` | `balanced` + within an equal group, the cheap tier (`cost_tier`) comes first. |
| `off` | The chain is used as is; only 100%-full limits are skipped. |

When the balancer changes the order, the reason appears in the `job_dispatch` warnings and in the job's `route` event. Example (actual output): `yük dengeleyici (balanced): codex yerine cirak — codex: five_hour rezerve ulaştı` ("load balancer (balanced): cirak instead of codex — codex: five_hour reached reserve").

```json
{ "balancer": { "strategy": "protect-brain" } }
```

## 7d. Token optimization

These work without any extra configuration:

- **Cache-friendly job brief:** the part that is identical across every job of the same role (rules, role, output contract, schema) is placed at the start of the brief. The job-specific part (IDs, task, instructions, memory) comes last. This way the provider's prompt cache lowers the input cost of the repeated prefix to about 0.1×.
- **Short brief in fix-up rounds:** when the worker session is resumed, the task and rules are not resent. Only the new IDs, instructions and findings are added.
- **Summary limit:** the worker's `summary` field may be at most 2000 characters; if longer it is truncated with a warning. This keeps the manager's context small.
- **Codex telemetry off:** `analytics.enabled=false` is passed to Codex jobs.

**Token profile.** Sets the reasoning level (effort) per role. Passed to Codex as `model_reasoning_effort` and to cirak as `--effort`.

| Profile | implementation | review | analysis | test |
|---|---|---|---|---|
| `saver` | medium | medium | low | low |
| `balanced` (default) | medium | high | medium | low |
| `quality` | high | high | high | medium |
| `off` | worker's own default | | | |

```json
{
  "token_profile": "saver",
  "workers": { "codex": { "effort": { "review": "high" } } }
}
```

`workers.<id>.effort` can be either a single value or a per-role map, and overrides the profile.

## 7e. Extension gate (SkillSpector)

External skills and MCP servers can be installed and run in Anafor projects only if they pass a [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) scan.

The scan always runs with `--no-llm`, so file contents are never sent to any LLM provider. The only external call is a lookup of dependency names on OSV.dev.

| SkillSpector result | Decision |
|---|---|
| Scan error | Blocked (fail-closed) |
| HIGH / CRITICAL (score > 50, `DO_NOT_INSTALL`) | Blocked |
| CAUTION (score 21–50) | Installed only with `--accept-risk`; the approval is recorded |
| SAFE (score 0–20) | Installed |

```bash
anafor ext add ./my-skill                                     # local directory
anafor ext add https://github.com/org/skills --path pdf       # a skill from a git repository
anafor ext add-mcp search --source https://github.com/org/search-mcp -- npx -y search-mcp@1.2.3
anafor ext adopt codex-gpt --user                             # scan an already-installed skill in place
anafor ext check                                              # status of installed ones
anafor ext list
```

**Registry.** Extensions that pass the scan are recorded with a content digest (sha256):
- project scope: `.anafor/extensions.json`
- user scope: `~/.anafor/extensions.json`

If the files change later, the extension will not run until it is rescanned. For MCP servers, if the command in `.mcp.json` differs from the recorded one, the server is still blocked.

**Enforcement** is done by the PreToolUse hook and is independent of the manager mode. Setting: `extensions.enforce`; values `block` (default), `warn` and `off`.
- The `Skill` tool invoking an unregistered or modified local skill (`.claude/skills`, `~/.claude/skills`) is blocked.
- Tools of an unregistered server in the project's `.mcp.json` are blocked.
- Direct writes to skill directories or `.mcp.json` are blocked. Commands like `claude mcp add`, `claude plugin install`, `codex mcp add`, `npx skills add` are also blocked and the user is redirected to `anafor ext`.
- The agent cannot give `--accept-risk` approval. Findings are shown to the user; if the user approves, they run the command in their own terminal.
- Blocked extensions are listed at SessionStart. `anafor doctor` shows whether SkillSpector is installed.

**Installation** (Python 3.12 or 3.13):

```bash
py -3.13 -m venv ~/.anafor/tools/skillspector            # Linux/macOS: python3.13 -m venv …
~/.anafor/tools/skillspector/Scripts/python -m pip install git+https://github.com/NVIDIA/skillspector.git
```

To use an installation in a different location, set `extensions.skillspector_bin`.

**Limits:**
- SkillSpector is not a sandbox. A clean result does not prove an extension is safe; it is one layer of defense.
- Extensions installed manually outside Anafor are only detected.
- Skills/MCPs bundled with plugins and claude.ai connectors are out of scope.

## 8. Migrating from the old software-orchestrator

```bash
node /path/anafor-mcp/dist/cli/main.js migrate /your-project
```

`.orchestrator/` is copied **read-only**: policy (bound to the new project ID), task history, audit, checkpoints and metrics. Worker sessions are not migrated. If run again, it refuses.

## 8b. Workers and terms of use

| Worker | How | Status | Terms note |
|---|---|---|---|
| `codex` | `codex exec` (your own ChatGPT login or API key) | ✅ verified | Official CLI; details below |
| `cirak` | `claude -p --model haiku` | ✅ verified | Official `claude` binary; details below. `ANTHROPIC_API_KEY` is removed from the worker environment |
| `local` | OpenAI-compatible API (Ollama, LM Studio) | ✅ tested with a fake server | Only `analysis`/`review` (does not edit files) |
| `opencode` | `opencode run --format json` | ✅ verified (real opencode 1.19.5 + OpenAI-compatible provider) | API key, local model or ChatGPT plan. **A Claude subscription cannot be used with OpenCode**; `anthropic/*` models only with `allow_anthropic_api` |
| `gemini` | `gemini -p --output-format stream-json --approval-mode auto_edit\|plan` | ✅ verified (real gemini-cli 0.68 + Gemini-API-compatible fake server) | Google AI Pro/Ultra login ended on 2026-06-18; API key, Vertex, or Code Assist Standard/Enterprise only |
| `antigravity` | `agy -p --output-format stream-json --json-schema <file> --mode accept-edits\|plan` | ✅ verified (real agy 1.5.9 + real account, conformance test), **disabled by default** | Google terms do not support wrapping consumer AI Pro/Ultra access in a third-party agent/app; it may violate the terms and risk account suspension. Optional use requires explicit consent and is the user's responsibility |

**Usage boundary:** Anafor is for personal, local use: your own account and machine, official, unmodified CLIs. It does not read, store, or transmit credentials/session tokens, or bypass limits. Do not offer Anafor as a hosted service to others through your subscription. High parallelism may trigger provider restrictions.

- **Claude:** Anthropic's [Legal & Compliance](https://code.claude.com/docs/en/legal-and-compliance) page permits your own subscription login with the official `claude` binary for ordinary, individual usage. Credential brokering and routing on behalf of others are prohibited.
- **Codex:** official CLI and your own ChatGPT login. The [OpenAI Usage Policies](https://openai.com/policies/usage-policies/) (2026-11-20) prohibit using OpenAI outputs to develop data, scores, or rankings for training competing models. Anafor worker statistics and measurements are for evaluation/benchmarking only and must not be exported as training data. Platforms providing model access to others require OpenAI approval.
- **Gemini CLI:** Google AI Pro/Ultra login ended on 2026-06-18; API key, Vertex, or Code Assist Standard/Enterprise only.
- **Antigravity:** Google's [FAQ](https://antigravity.google/docs/faq) and [Additional Terms §6](https://antigravity.google/terms) do not support wrapping consumer AI Pro/Ultra access in a third-party agent/app and say it may violate the terms; your account may be suspended. Optional use is only at the user's explicit consent and responsibility. Google recommends Gemini Enterprise or an [AI Studio API key](https://developers.googlebloggers.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli).
- This information is not legal advice.
- This summary is not legal advice; check the providers' current terms yourself.

Example configuration:

```json
{
  "workers": {
    "local": { "model": "qwen3-coder", "base_url": "http://127.0.0.1:11434/v1" },
    "opencode": { "model": "ollama/qwen3-coder" },
    "antigravity": { "enabled": false }
  },
  "routing": { "review": ["codex", "local", "cirak"] }
}
```

**Antigravity and terminal commands:** headless `agy` automatically denies commands because it cannot ask for permission. Anafor does not use a permission-bypass flag; instead it uses a session-specific `--settings` to allow only these commands: the project's `test_command` value and `workers.antigravity.allowed_commands`. agy 1.5.9 does not support wildcards; commands must match **exactly**. The allowlist is also written into the job brief. Denied commands appear as `error` in the job events.

```json
{ "test_command": "npm test", "workers": { "antigravity": { "enabled": false, "allowed_commands": ["npm run lint"] } } }
```

For optional Antigravity consumer-plan use, accept the `anafor setup` prompt or add `{ "workers": { "antigravity": { "enabled": true, "accept_terms_risk": true } } }` only to the uncommitted `.anafor/config.json`. This option is used at the user's own discretion and responsibility. Anafor and its developers are not responsible for any outcome, including restriction or termination of your Google account. This information is not legal advice.

Real conformance tests (Antigravity: after logging in once with `agy`, `ANAFOR_AGY_BIN=<path to agy.exe> ANAFOR_E2E_AGY=1`):
- OpenCode, with a fake provider, no account needed: `ANAFOR_E2E_OPENCODE_BIN=<path to opencode> npx vitest run test/integration/opencode-real.test.ts`
- Gemini, with a fake API, no account needed: `ANAFOR_E2E_GEMINI_BIN=<path to gemini> npx vitest run test/integration/gemini-real.test.ts`
- With real models: `npx vitest run test/integration/conformance.test.ts` with `ANAFOR_E2E_OPENCODE_MODEL=ollama/qwen3-coder`, `ANAFOR_E2E_GEMINI=1`, `ANAFOR_E2E_AGY=1`

## 9. Adding a new worker

1. `src/adapters/<worker>.ts`: `WorkerAdapter` (`detect`, `capabilities`, `start`, optional `resume`). Convert events to `WorkerEvent`; the last message must be `WorkerResult v1` JSON.
2. Add one line to `src/adapters/registry.ts`.
3. `anafor.config.json` → `routing`.
4. Add one line to `test/integration/conformance.test.ts` and run it with the real worker.

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| `NOT_INITIALIZED` | `anafor init` in the project root |
| `WORKER_UNAVAILABLE` | `anafor doctor`; `codex login`; reasons in `workers_list` |
| `invalid_output` | `job_events` / `.anafor/jobs/<job>/stdout.log`; the worker did not follow the schema, dispatch again |
| `CONFLICT` (shared) | Only one writing job in the shared workspace; use a worktree |
| `task_merge` CONFLICT | Uncommitted changes in tracked files; commit or stash. Untracked files do not block |
| `task_merge` merge conflict | The merge was rolled back; dispatch a fix job for the conflicting files or use `intervene` |
| Codex job `partial`, tests fail with `spawn EPERM` (Windows) | The Codex sandbox prevents the test runner from spawning child processes. `evidence_generate` → review the diff → `task_accept` + `verified_by_evidence_reason` |
| Gemini: `Invalid auth method selected` | `security.auth.selectedType` must be set in `~/.gemini/settings.json` (`anafor doctor` shows it) |
| The hook blocks everything | `anafor.config.json` → `director_mode: "warn"` (temporarily) |

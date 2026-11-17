🇹🇷 [Türkçe](README.md)

# anafor-mcp

**Anafor** is an orchestration system that makes Claude Code the _manager_ and other AI coding agents (starting with OpenAI Codex CLI) its _workers_.

- Claude plans, splits the work, dispatches it to workers, reviews the result and accepts it.
- Workers run tasks in isolated workspaces and return a structured result **validated against a JSON Schema**.
- Communication happens through typed **MCP tools**. The rules (edit ban, acceptance gates, permission policy) are enforced in code, not in the prompt.
- Adding a new AI is as easy as writing a `WorkerAdapter`.

> **Status:** v0.3. Claude Code as manager; Codex, Claude Haiku, OpenCode, Gemini, Antigravity and local-model workers; worktree parallelism, acceptance and governance gates, terminal CLI (`anafor chat/run`), limit tracking, automatic Lat.md context and a worktree dependency cache.

## Architecture (overview)

```
Claude Code (manager) ──MCP──▶ anafor-mcp server ──▶ runner (detached process) ──▶ adapter ──▶ Codex / other workers
        ▲   plugin: hooks,             │  state machine, schema validation,            │
        └── commands, instructions     └─ SQLite (.anafor/state.db)                     └─ git worktree
```

## Requirements

- Node.js 24+
- Claude Code
- At least one worker: [Codex CLI](https://github.com/openai/codex)

> **AI agents:** to install or repair Anafor for a user, follow [docs/agent-install.md](docs/agent-install.md) (step by step, with `anafor doctor --json` codes).

## Quick start (new machine)

```bash
npm install -g https://github.com/frudotz/anafor-mcp/releases/latest/download/anafor-mcp.tgz   # requires Node 24+, git, Claude Code and at least one worker
cd /your-project && anafor setup             # wizard: workers, persistent plugin, statusline, project
anafor chat                                  # talk to the brain agent from the terminal
```

Details: **[docs/en/installation.md](docs/en/installation.md)**.

Example request inside Claude Code: _"Open a task with Anafor, dispatch it to Codex, and review the result when it's done."_

### MCP tools (v0.1)

| Tool | Purpose |
|---|---|
| `workers_list`, `project_status` | Workers and project board |
| `task_create`, `task_status` | Task with acceptance criteria |
| `job_dispatch` | Hands a job to a worker; returns `job_id` immediately, the job runs in a detached process |
| `job_wait`, `job_status`, `job_events` | Wait up to 50 s, status, event log |
| `job_result` | Schema-validated result, token usage, artifact paths |
| `job_request_changes` | Fix-up with findings, in the same worker session (at most 5 per task) |
| `job_cancel` | Cancel and kill the process tree |
| `job_diff` | Diff against the HEAD at job start and mismatches with the worker report |
| `task_accept` | Acceptance gates (tests, missing requirements, critical findings, evidence; independent review in deep mode) |
| `task_close` | Close a task without accepting it |
| `task_merge` | Merge an accepted task branch into the branch of the working tree (clean tree required, rolled back on conflict) |
| `workspace_cleanup` | Safely clean up worktrees and merged branches of finished jobs |
| `intervene`, `intervene_end` | Snag exception: time-boxed, path-restricted, audited direct edit permission |
| `checkpoint`, `operation_authorize`, `operation_record` | Governance: git state snapshot, policy and evidence gate, append-only audit |
| `memory_lock`, `memory_metrics` | Exclusive write lease and metrics for Lat.md memory |

### Parallel work: git worktree

In a git repository, `implementation` and `test` jobs run in **their own worktrees** by default:

```
main (your working tree: untouched)
 └─ anafor/<task>              task branch
     ├─ anafor/<task>-<job1>   .anafor/worktrees/<job1>
     └─ anafor/<task>-<job2>   .anafor/worktrees/<job2>
```

- Fix-up and follow-up jobs continue in the same worktree, in the same worker session.
- A `review` job inspects the target job's worktree read-only via `target_job_id`.
- `task_accept` commits the changes to the job branch and merges them into the task branch; `task_merge` brings the task branch into your branch.
- To install dependencies in a new worktree: `anafor.config.json` → `"worktree_setup": "npm ci"`. Faster: `"worktree_cache": { "paths": ["node_modules"], "key_files": ["package-lock.json"] }` (if the lock file is identical, a hardlink copy is made and installation is skipped).

### Workers and routing

| Worker | Invocation | Note |
|---|---|---|
| `codex` | `codex exec --json --output-schema` | Default implementation worker |
| `claude-lite` | `claude -p --model haiku --json-schema` | Cheap analysis, tests and cross-review; no MCP loaded, no permission bypass |
| `fake` | deterministic script | Testing and dry runs |

If no worker is specified, `job_dispatch` picks the first available worker from the role's preference order. For review jobs, a worker **different** from the one that did the target job is preferred. Settings:

```json
{
  "routing": { "implementation": ["codex", "claude-lite"], "review": ["codex", "claude-lite"] },
  "workers": { "claude-lite": { "model": "haiku", "max_concurrency": 3 }, "codex": { "enabled": true } }
}
```

Adding a new worker: a class implementing `WorkerAdapter` + one line in `src/adapters/registry.ts`. Conformance test: `test/integration/conformance.test.ts`.

### Claude Code plugin (manager discipline)

```bash
claude --plugin-dir /path/to/anafor-mcp/plugin
```

- **PreToolUse hook:** in Anafor projects, blocks Claude from editing code files directly and from running file-modifying shell commands, redirecting the work to `job_dispatch`. Documentation and memory paths are allowed. Mode: `anafor.config.json` → `"director_mode": "enforce" | "warn" | "off"`.
- **SessionStart hook:** role reminder and task board at session start.
- **Commands:** `/anafor:plan`, `/anafor:run`, `/anafor:status`, `/anafor:accept`.

Detailed guide: **[docs/en/usage.md](docs/en/usage.md)**. Migrating from the old `software-orchestrator` state: `anafor migrate`.

## Development

```bash
npm install
npm run check   # format + types + build + test
ANAFOR_E2E_CODEX=1 ANAFOR_E2E_CLAUDE=1 npx vitest run test/integration/conformance.test.ts   # conformance with real workers (optional)
npm run build
```

Contribution guidelines: [CONTRIBUTING.md](CONTRIBUTING.md)

## License, forks and attribution

Anafor is licensed under [AGPL-3.0-only](LICENSE). You are free to fork it, modify it and develop it along your own roadmap, under these conditions:

- **Keep `LICENSE` and [`NOTICE`](NOTICE).** Under AGPL-3.0 §7(b), NOTICE requires the **original source and original authors** (https://github.com/frudotz/anafor-mcp, frudotz and RedRiveRR) to be credited in your README and in the output of `anafor version`.
- **Mark your changes (§5(a)).** Do not present a modified version as the original Anafor.
- **Derivative works are AGPL-3.0 too.** If you offer a modified version to others over a network (for example as an MCP server), you must give those users its source code (§13).
- **Send fixes back.** Bugs you fix in your fork help everyone when you open a PR upstream: [docs/sharing-fixes.md](docs/sharing-fixes.md).

This section is not legal advice; [LICENSE](LICENSE) is authoritative.

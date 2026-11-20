# Installing Anafor with an AI agent

This guide is for **AI coding agents** (Claude Code, Codex, Gemini, Cursor, …) that are asked to install or repair Anafor for a user. It is written to be followed step by step; every diagnostic has a stable code from `anafor doctor --json`.

Human-oriented docs (Turkish): [kurulum.md](kurulum.md), [kullanim.md](kullanim.md).

## Ground rules (do not break these)

1. **Never use permission or sandbox bypasses**: no `--dangerously-*`, `bypassPermissions`, `--yolo`, `--dangerously-skip-permissions`.
2. **Never handle credentials.** Logins (`claude auth login`, `codex login`, API keys) are done by the user. Ask them to run the command themselves; in Claude Code they can type `! <command>`.
3. **Never accept a security risk for the user.** `anafor ext … --accept-risk` is blocked for agents on purpose. Show the SkillSpector findings and let the user decide.
4. **Do not hand-edit** `~/.claude/settings.json`, `.claude/skills/`, `.mcp.json` or the Anafor plugin directory. Use `anafor setup` / `anafor ext`.
5. **Install only from the release tarball.** `npm install -g github:frudotz/anafor-mcp` does not work (npm skips dependencies for git installs).
6. Prefer non-interactive flags; Anafor prompts fall back to safe defaults when stdin is not a TTY.

## Procedure

```text
1. Check prerequisites        node --version (>= 24) · git --version · claude --version
2. Install                    npm install -g https://github.com/frudotz/anafor-mcp/releases/latest/download/anafor-mcp.tgz
3. Verify                     anafor version
4. Global setup (no prompts)  anafor setup --yes --no-project
5. Connect the project        cd <git repo with at least one commit> && anafor init
6. Diagnose                   anafor doctor --json   → fix every code in "problems", then "warnings" (table below)
7. Repeat 6 until ok == true and the remaining warnings are understood by the user
8. Tell the user              restart Claude Code (hooks and plugin load at session start)
```

`anafor doctor --json` prints:

```json
{ "version": "0.10.0", "ok": true, "problems": [], "warnings": ["CODEX_SANDBOX_UNELEVATED"],
  "checks": [{ "code": "…", "section": "…", "status": "ok|warn|fail|off", "label": "…", "info": "…", "fix": "…" }] }
```

Exit code is `1` when `problems` is non-empty. `off` means "not configured" and is fine unless the user wants that feature.

## Diagnostic codes

| Code | Meaning | Who acts | Action |
|---|---|---|---|
| `VERSION` | Installed version | — | — |
| `UPDATE_AVAILABLE` | A newer release exists | agent | `anafor update` (verifies SHA-256, refreshes the plugin) |
| `SETUP_MISSING` | Setup wizard never ran | agent | `anafor setup --yes --no-project` |
| `PLUGIN_OK` | Plugin installed persistently | — | — |
| `PLUGIN_SESSION` | Plugin not installed persistently | agent | `anafor setup --yes --no-statusline --no-project` |
| `PLUGIN_OUTDATED` | Plugin older than the CLI | agent | `anafor setup --yes --no-statusline --no-project`, then ask the user to restart Claude Code |
| `NODE_OK` / `NODE_OLD` | Node.js version | user | Install Node 24+ (https://nodejs.org); do not downgrade Anafor |
| `CLAUDE_OK` / `CLAUDE_MISSING` | Claude Code CLI | user | Install Claude Code, then the user runs `claude auth login` |
| `GIT_REPO` / `NOT_GIT_REPO` | Current dir is a git repo | agent (ask first) | `git init && git commit --allow-empty -m init` only if the user wants this directory as a project |
| `PROJECT_NOT_INIT` | Directory not connected to Anafor | agent | `anafor init` inside the project |
| `STORE_OK` / `STORE_ERROR` | `.anafor/state.db` opens | user | Usually locked by another process: close other Claude Code sessions and retry. Never delete the database |
| `PERMISSION_DENIALS` | Permission denials observed in the last seven days | info | Run `anafor permissions` to inspect session, tool, reason and narrow allow suggestions |
| `JOBS_OK` / `JOBS_FAILING` | ≥3 failed jobs in 24 h | agent | `anafor jobs --all`, read the error column; common causes are the worker codes below |
| `EXTENSIONS_OK` / `EXTENSIONS_BLOCKED` | Skills/MCP servers not scanned or changed | agent + user | `anafor ext check`; for each: `anafor ext adopt <name> [--user]`. If the result is CAUTION, show the findings and let the **user** run the command with `--accept-risk` |
| `SKILLSPECTOR_OK` / `SKILLSPECTOR_MISSING` | NVIDIA SkillSpector for the extension gate | agent (ask first) | Optional. Python 3.12/3.13: `python3.13 -m venv ~/.anafor/tools/skillspector` then `~/.anafor/tools/skillspector/bin/python -m pip install git+https://github.com/NVIDIA/skillspector.git` (Windows: `Scripts\python`) |
| `WORKER_OK` | Worker ready | — | — |
| `WORKER_AUTH` | Worker installed but not logged in | user | e.g. the user runs `codex login` |
| `WORKER_UNAVAILABLE` | Worker not installed/configured | user decides | Optional. Follow the `fix` text; Gemini CLI needs `GEMINI_API_KEY` (personal Google logins were discontinued on 2026-06-18) |
| `WORKER_WARNING` | Worker ready with a caveat | agent | Read `fix` |
| `CODEX_SANDBOX_UNELEVATED` | Windows Codex sandbox cannot spawn processes (tests fail with `spawn EPERM`) | agent | In `anafor.config.json`: `{"workers":{"codex":{"windows_sandbox":"elevated"}}}` |
| `NO_WORKERS` | No usable worker | user | Install at least one: `npm install -g @openai/codex`, then the user runs `codex login` |

## Common install errors

| Symptom | Cause | Fix |
|---|---|---|
| `npm ERR! code EACCES` (macOS/Linux) | Global npm prefix not writable | `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to `PATH`. Do not use `sudo npm` |
| `anafor: command not found` | npm global bin not on `PATH` | Add the output of `npm prefix -g` (Windows) or `$(npm prefix -g)/bin` to `PATH` |
| PowerShell: "running scripts is disabled" | Execution policy blocks `anafor.ps1` | Call `anafor.cmd` instead, or let the **user** decide on `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `npm install -g github:…` fails with `tsc` errors | Git installs skip dependencies | Use the release tarball URL above |
| Plugin commands `/anafor:*` missing | Claude Code session predates install | Restart Claude Code; then `claude plugin list` shows `anafor@anafor-local` |
| Statusline unchanged | Another statusline exists and is kept | Expected; Anafor never overwrites a foreign statusline. The user can switch manually |
| `ANAFOR eklenti kapısı: …` when calling a skill | Extension not scanned | See `EXTENSIONS_BLOCKED` |
| `Global eşzamanlılık sınırı … dolu` | `max_parallel_jobs` reached | Wait (`job_wait`) or raise `max_parallel_jobs` in `anafor.config.json` |

## Choosing workers and roles

After setup, ask the user which AI subscriptions they have, then:

```bash
anafor capacity recommend                                   # list subscription ids
anafor capacity recommend claude-max,chatgpt-plus           # show the recommended role split
anafor capacity recommend claude-max,chatgpt-plus --apply   # write it to anafor.config.json
```

The brain (manager) is always Claude Code. Do not enable `antigravity` without the user explicitly acknowledging its terms (`workers.antigravity.acknowledge_terms`).

## Updating

```bash
anafor update --check   # is there a newer release?
anafor update           # download, verify SHA-256, install, refresh plugin
```

## Fixed something in Anafor? Share it

If a diagnostic led you to change Anafor's **source code** (not just the user's configuration), ask the user whether to send the fix upstream so every user gets it via `anafor update`. Follow [sharing-fixes.md](sharing-fixes.md): reproduce with a test, keep the change minimal, run `npm run check` and the [contribution guard](contribution-guard.md), and include the doctor code in the PR.

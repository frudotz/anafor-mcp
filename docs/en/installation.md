🇹🇷 Türkçe: [kurulum.md](../kurulum.md)

# Installing Anafor (new machine, ~5 minutes)

## 1. Prerequisites

| Component | Why | Install |
|---|---|---|
| **Node.js 24+** | Anafor runtime | https://nodejs.org (Windows: `winget install OpenJS.NodeJS`) |
| **git** | worktree isolation | https://git-scm.com |
| **Claude Code** | brain (manager) | https://claude.com/claude-code → `claude auth login` |
| At least one worker | the agent that does the work | see below |

Workers (at least one):

| Worker | Install |
|---|---|
| Codex (recommended) | `npm install -g @openai/codex` → `codex login` |
| Claude Haiku (`cirak`) | Nothing extra; Claude Code is enough |
| Local model | Ollama (https://ollama.com) or LM Studio → `anafor.config.json` |
| OpenCode / Gemini / Antigravity | experimental; Google terms do not support third-party Antigravity use on consumer plans. Optional use is at the user's responsibility; see [usage.md](usage.md#8b-workers-and-terms-of-use) |

### Optional: gitleaks (recommended)

If gitleaks is on PATH, `evidence_generate` runs it in addition to the built-in scanner. Gitleaks also catches unquoted and high-entropy keys the built-in scanner misses. The verified version is **v8.30.1**; install it with checksum verification:

```bash
gh release download v8.30.1 --repo gitleaks/gitleaks --pattern "gitleaks_8.30.1_<os>_<arch>.*" --pattern "gitleaks_8.30.1_checksums.txt"
sha256sum -c --ignore-missing gitleaks_8.30.1_checksums.txt   # must match
```

### Windows: Codex sandbox mode (important)

Codex's default **unelevated** sandbox on Windows does not allow creating named pipes. As a result, every child process launched from within the worker that uses piped stdio fails with `spawn EPERM`: `npm test`, vitest/jest, compilers. In the end Codex cannot run tests. The **elevated** sandbox runs under separate `CodexSandbox*` accounts and does not have this problem.

```json
{ "workers": { "codex": { "windows_sandbox": "elevated" } } }
```

- The setting applies only to Anafor's Codex jobs (`-c windows.sandbox="elevated"`); your `~/.codex/config.toml` is not touched.
- Elevated mode requires a one-time setup with administrator approval (Codex asks on first use). `anafor doctor` shows the current state.
- If the project is under `AppData`, the sandbox account cannot access it; keep the project under, for example, the Desktop or `C:\src`.
- Codex also keeps every `.git` directory read-only; the worker does not commit, Anafor does.

## 2. Install Anafor

```bash
npm install -g https://github.com/frudotz/anafor-mcp/releases/latest/download/anafor-mcp.tgz
```

This is the release package built in CI; nothing is compiled at install time. A specific version: `…/releases/download/v0.2.0/anafor-mcp-0.2.0.tgz` (SHA-256 values are in the release's `SHA256SUMS.txt`). To verify: `anafor version`.

> **Do not** use `npm install -g github:frudotz/anafor-mcp`: npm does not install dependencies when installing from git, so the build fails.

> Developer install (from source): `git clone https://github.com/frudotz/anafor-mcp && cd anafor-mcp && npm install && npm link`

## 3. Run the wizard

```bash
cd /your-project    # a git repository with at least one commit
anafor setup
```

Wizard steps:

0. **Language:** Türkçe or English. The choice is saved to `~/.anafor/setup.json`. For non-interactive setup use `--lang tr|en`; to switch temporarily, set `ANAFOR_LANG=en`.

1. **Environment:** checks Node, git and Claude Code.
2. **Workers:** which are ready, session and limit status, install hints for missing ones.
3. **Plugin:** generates the Anafor plugin. If you approve, it installs it into Claude Code **persistently** with the official `claude plugin install` command, so `--plugin-dir` is not needed.
4. **Statusline:** adds a status line to `~/.claude/settings.json`. An existing statusLine is left untouched; a backup is made before any change. The line shows:

   ```
   anafor v0.7.0 · ⬆ v0.8.0: anafor update · ⚠ 2 jobs failed: anafor doctor · 5h %24 · 7d %33
   ```

   - **Version:** installed Anafor version.
   - **New version:** shown with the update command, if available. The check runs in the background every 6 hours and never blocks the statusline. Only public GitHub Release information is read. To disable: `ANAFOR_NO_UPDATE_CHECK=1`.
   - **Stability hints:**
     - If the plugin is older than the CLI: `anafor setup`.
     - If the last `anafor doctor` found problems: `anafor doctor`.
     - If more than 2 jobs failed in the project in the last 2 hours: `anafor doctor`.
   - **Model and Claude limits.**
5. **Project:** connects the current git repository to Anafor (`anafor init`). The default answer is "no".

Non-interactive setup: `anafor setup --yes`. Add `--no-plugin`, `--no-statusline` or `--no-project` for the steps you want to skip.

### Claude Code PR attribution

`anafor attribution enable|disable|status` manages project PR attribution in `.claude/settings.json`; a backup is created only when changing the file and no `.bak` exists. Custom `attribution.pr` text is preserved. `anafor init` and `anafor setup` ask first; `--yes` confirms, while noninteractive runs do not write. See the [Claude Code settings reference](https://code.claude.com/docs/en/settings-reference.md) for formats and defaults. `attribution: false` and an empty `pr` value are preserved.
## Updating

```bash
anafor update          # download the latest release, verify SHA-256, install, refresh the plugin
anafor update --check  # only check whether a new version exists
```

`anafor update` follows these steps:
1. Downloads the release's `SHA256SUMS.txt` and the package.
2. Verifies the digest. On mismatch nothing is installed.
3. Installs the package with `npm install -g`.
4. Refreshes the plugin with `anafor setup --yes --no-statusline --no-project`.

Then restart Claude Code.

## 4. Use it

```bash
anafor chat                      # talk to the brain agent from the terminal
# or
claude                           # inside Claude Code: /anafor:plan <goal>
anafor jobs | anafor watch       # watch jobs
anafor limits                    # session/usage limits
anafor roles set review codex,cirak
anafor doctor                    # sectioned checks; the result is reflected in the statusline
```

## Terms of use summary

- Anafor is for personal, local use: your own account and machine, with official, unmodified CLI binaries. It does not read, store, or transmit credentials/session tokens, or bypass limits. High parallelism may trigger provider restrictions. Do not offer Anafor as a hosted service to others through your subscription.
- **Claude:** Anthropic's [Legal & Compliance](https://code.claude.com/docs/en/legal-and-compliance) page permits your own subscription login through the official `claude` binary for ordinary, individual usage. Credential brokering and routing on behalf of others are prohibited. `ANTHROPIC_API_KEY` is removed from worker environments.
- **Codex:** use the official CLI and your own ChatGPT login. Under the [OpenAI Usage Policies](https://openai.com/policies/usage-policies/) (2026-11-20), OpenAI outputs may not be used to develop data, scores, or rankings for training competing models. Anafor worker statistics and measurements are for evaluation/benchmarking only and must not be exported as training data. Platforms that provide model access to others require OpenAI approval.
- **Gemini CLI:** Google AI Pro/Ultra login was discontinued on 2026-06-18; only an API key, Vertex, or Code Assist Standard/Enterprise is available.
- **Antigravity:** Google's [FAQ](https://antigravity.google/docs/faq) and [Additional Terms §6](https://antigravity.google/terms) do not support wrapping consumer AI Pro/Ultra access in a third-party agent/app and say it may violate the terms; your account may be suspended. Optional use is only at the user's explicit consent and responsibility. Google recommends Gemini Enterprise or an [AI Studio API key](https://developers.googlebloggers.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli).
- This information is not legal advice.
- This summary is not legal advice; check the providers' current terms yourself.
- Details: [usage.md](usage.md).

## Uninstalling

Google's terms do not support consumer AI Pro/Ultra access through a third-party agent/app; optional use requires explicit consent and is at the user's own responsibility. Approving `anafor setup` writes `workers.antigravity.enabled: true` and `workers.antigravity.accept_terms_risk: true` only to the uncommitted `.anafor/config.json`. Anafor and its developers are not responsible for outcomes including restriction or termination of your Google account. This is not legal advice.

```bash
claude plugin uninstall anafor@anafor-local   # if installed persistently
npm uninstall -g anafor-mcp
# optional: ~/.anafor (limits, setup state) and .anafor/ in projects can be deleted
```

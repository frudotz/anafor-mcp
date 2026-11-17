# Sharing a fix with every Anafor user

🇹🇷 Türkçe özet: [CONTRIBUTING.md §10](../CONTRIBUTING.md#10-doctor-ile-bulunan-sorunların-çözümünü-paylaşmak)

`anafor doctor` (and `anafor doctor --json`) reports problems with stable codes. If you, or the AI agent in your environment, fixed a problem in **Anafor itself** (not just in your local configuration), please send the fix upstream. One person's patch then reaches every user through `anafor update`.

This guide is written for both humans and AI agents.

## Is it an Anafor bug or a local issue?

| Situation | Share as |
|---|---|
| The `fix` text from `doctor` solved it (installing a tool, logging in, setting a config key) | Nothing to share. If the `fix` text was wrong or unclear, open an **issue** |
| You changed Anafor's source (`src/`, `scripts/`, `plugin/`, `schemas/`) to make it work | **Pull request** (this guide) |
| A doctor check was missing, misleading, or reported the wrong code | Pull request: improve the check and `docs/agent-install.md` |
| A worker CLI changed its flags or output (Codex, Claude, OpenCode, …) | Pull request with a test that reproduces the new output |
| Security problem | **Do not open a public PR or issue.** Follow `SECURITY.md` |

## Steps

1. **Fork and branch.** Fork `frudotz/anafor-mcp`. Name the branch `<you>/fix/<short-name>`; agents use `claude/fix/…` or `codex/fix/…`.
2. **Reproduce in a test.** Add or extend a test under `test/` that fails without your fix. For doctor-related fixes, include the `anafor doctor --json` code(s) involved.
3. **Keep the change minimal.** Fix one problem per PR. No drive-by refactors, no new dependencies unless unavoidable.
4. **Run the checks locally.**
   ```bash
   npm ci
   npm run check                                                   # format + types + tests
   node scripts/contribution-guard.mjs --base origin/main --head HEAD   # contribution guard
   ```
5. **Open the PR.** The template asks for:
   - the doctor code(s) and your OS / Node / worker CLI versions;
   - the root cause, in one or two sentences;
   - how you verified the fix.

   Remove secrets, usernames and local paths from logs before pasting them.
6. **CI and the contribution guard** run automatically. If the guard reports a `review` finding (for example you touched `package.json`), a maintainer will review it. A `block` finding means the change must be reworked; see [contribution-guard.md](contribution-guard.md).

## Notes for AI agents

- Ask the user before forking or opening a PR in their name. Show them the diff and the PR text first.
- Never include credentials, tokens, session files or the user's personal data in commits, PR text or logs.
- Do not add `--dangerously-*` flags, install scripts, telemetry, obfuscated code or new network endpoints. The guard blocks them, and they would not be accepted anyway.
- Prefer fixing the root cause in Anafor over adding workarounds in the user's config.

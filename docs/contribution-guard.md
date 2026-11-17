# Contribution guard (rule set)

🇹🇷 Özet Türkçe: [CONTRIBUTING.md §9](../CONTRIBUTING.md#9-katkı-koruması)

Anafor installs into users' machines and controls AI agents with real permissions. A malicious change merged here would be shipped to every user by `anafor update`. Many contributions are also written by AI agents running under Anafor itself. The **contribution guard** makes sure nobody can use "contributing to Anafor" as a vehicle to spread malicious code.

## How it works

- Every pull request runs the `Contribution Guard / guard` check (`.github/workflows/contribution-guard.yml`).
- It uses **`pull_request_target`**: the workflow and `scripts/contribution-guard.mjs` come from the **base branch**, so a PR cannot weaken the guard that judges it. The PR's code is fetched with `git fetch` and analysed **as data**. It is never executed and its dependencies are never installed. The token is read-only.
- Findings have two severities:
  - **block**: the PR cannot merge. A maintainer may override after review by adding the `guard-approved` label (labels require write access).
  - **review**: trusted contributors (owner, members, collaborators) pass with a notice. External contributors need a maintainer's `guard-approved` label.
- Run the same check locally before opening a PR: `node scripts/contribution-guard.mjs --base origin/main --head HEAD`.

## Rules

| Code | Severity | Rule |
|---|---|---|
| `G01` | review | New dependency or changed dependency version (`package.json`) |
| `G02` | block | Lockfile adds a package with an install script (`hasInstallScript`) |
| `G03` | block | Dependency from outside the npm registry (git, http tarball, `file:`, `user/repo`) |
| `G04` | block | Install lifecycle script added/changed (`preinstall`, `install`, `postinstall`, `prepare`, …) |
| `G05` | review | CI/CD workflow changed (`.github/workflows/`) |
| `G06` | review | Sensitive path changed: `.github/`, `package*.json`, `scripts/`, `plugin/`, `src/cli/update.ts`, `src/setup/`, `src/hooks/`, `src/extensions/`, `src/adapters/process.ts`, `src/runner/spawn.ts`, `schemas/`, the guard itself |
| `G07` | block | Dynamic code execution: `eval(`, `new Function(`, `vm.runIn…` |
| `G08` | review | New network endpoint (URL host not in the allow-list in the guard script) |
| `G09` | block | Obfuscation: line > 400 characters in code, or base64/hex blob ≥ 200 characters |
| `G10` | block | Binary, executable or archive file (`.exe`, `.dll`, `.node`, `.wasm`, `.tgz`, `.ps1`, `.bat`, …) |
| `G11` | block | Download-and-execute: `curl … \| sh`, `Invoke-Expression`, `iex(`, `powershell -enc` |
| `G12` | block | Credential access or environment exfiltration (`~/.ssh`, `.aws/credentials`, `.npmrc`, `.netrc`, dumping `process.env`) |
| `G13` | block | Permission/sandbox bypass flags in code (`--dangerously-*`, `bypassPermissions`, `--yolo`, `danger-full-access`) |
| `G14` | block | Telemetry/analytics SDKs or endpoints (PostHog, Mixpanel, Segment, Sentry, Statsig, …) |
| `G16` | block | Hidden Unicode (Trojan Source: bidi controls, zero-width characters) |
| `G17` | block | Built/minified JavaScript in source trees (`src/`, `scripts/`, `plugin/`; TypeScript and `.mjs` only) |
| `G18` | block | Hard-coded secrets (API keys, tokens, private keys) |
| `G19` | review | Spawning through a shell in `src/` (`shell: true`, `execSync`, `exec("…")`) |

Exemptions: documentation (`*.md`, `*.txt`) is exempt from most code rules. `test/fixtures/` is exempt from G09, G11 and G12 so that scanners can be tested with samples. The guard script itself is always G06 (maintainer review).

## For maintainers

- Read the full diff before adding `guard-approved`. The label overrides **all** findings for the current head.
- Treat `G01`/`G02`/`G03` like code review: check the package, its maintainers, its age (prefer versions older than two weeks), its install scripts and `npm audit`.
- `guard` is a **required status check** on `main` (ruleset "Kalite kapıları"), next to `check (ubuntu-latest)` and `check (windows-latest)`. A second ruleset requires an approval from a code owner (frudotz or RedRiveRR) for everyone else; the two maintainers can merge their own PRs independently. `v*` tags can only be created by maintainers.

## Limits

This is a pattern-based defence layer, not a proof of safety. It is designed to stop the obvious and the sneaky-but-common (install scripts, obfuscation, Trojan Source, exfiltration, bypass flags). It does not replace human review of sensitive changes, which is why those always route to a maintainer.

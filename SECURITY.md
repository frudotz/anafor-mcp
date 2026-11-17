# Security policy

## Reporting a vulnerability

Please **do not** open a public issue or pull request for security problems (for example a way to bypass the director hooks, the SkillSpector extension gate, the contribution guard, or to make `anafor update` install unverified code).

Use GitHub's private reporting instead: **Security → Report a vulnerability** on <https://github.com/frudotz/anafor-mcp>. Include the affected version (`anafor version`), your OS, reproduction steps and the impact. You will get an answer as soon as possible; please allow time for a fix and release before any disclosure.

## Supported versions

Only the latest release receives fixes. Update with `anafor update`.

## Design notes

- Releases are built in CI and published with `SHA256SUMS.txt`; `anafor update` refuses a package whose checksum does not match.
- Anafor never uses permission or sandbox bypass flags and never reads or stores AI subscription credentials.
- Contributions pass the contribution guard ([docs/contribution-guard.md](docs/contribution-guard.md)).

# AGENTS.md: yapay zekâ ajanları için kısa bağlam

> Bu dosya kısa tutulur (token tasarrufu). Ayrıntı için ilgili dosyayı **ihtiyaç olduğunda** açın; tüm repoyu taramayın.

## Proje
Anafor: Claude Code'u yönetici, diğer yapay zekâ ajanlarını (önce Codex CLI) işçi yapan MCP sunucusu + Claude Code plugin'i. TypeScript, Node 24+, ESM.

## Komutlar
- `npm run check`: biçim + tip + test (PR öncesi zorunlu)
- `npm test`: vitest · `npm run typecheck` · `npm run format`
- `npm run build`: `dist/` üretir

## Yapı (hedef)
`src/server` MCP araçları · `src/core` durum makinesi, kabul kapıları, prompt · `src/store` SQLite (`node:sqlite`) · `src/runner` ayrık iş süreci · `src/adapters/<işçi>` · `src/git` worktree · `src/hooks` Claude Code hook'ları · `src/cli` · `schemas/` JSON Schema (tek kaynak) · `plugin/` Claude Code plugin'i · `test/`

## Kurallar
- Dal: `<sahip>/<tür>/<kısa-ad>` (ajanlar: `claude/...`, `codex/...`). `main`'e doğrudan push yok, force push yok, başkasının dalına commit yok.
- Commit ve PR başlığı Conventional Commits: `feat(core): ...`.
- İzin veya sandbox atlatma bayrakları (`--dangerously-*`, bypass permissions) kullanılmaz.
- Gizli bilgi commit edilmez, loglanmaz.
- Yeni davranış = test. Ortak arayüz (`src/adapters/types.ts`, `schemas/`) değişikliği ayrı PR.
- Ayrıntılı kurallar: `CONTRIBUTING.md`.

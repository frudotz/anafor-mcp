# anafor-mcp

**Anafor**, Claude Code'u *yönetici*, diğer yapay zekâ kodlama ajanlarını (önce OpenAI Codex CLI) *işçi* yapan bir orkestrasyon sistemidir.

- Claude planlar, işi parçalar, işçiye dağıtır, sonucu inceler ve kabul eder.
- İşçiler izole çalışma alanlarında görevleri yürütür ve **JSON Schema ile doğrulanan** yapılandırılmış sonuç döner.
- İletişim, tipli **MCP araçlarıyla** kurulur. Kurallar (düzenleme yasağı, kabul kapıları, yetki politikası) prompt'ta değil, kodda uygulanır.
- Yeni bir yapay zekâ eklemek, bir `WorkerAdapter` yazmak kadar kolaydır.

> **Durum:** erken geliştirme (v0.1). Henüz kullanıma hazır değildir.

## Mimari (özet)

```
Claude Code (yönetici) ──MCP──▶ anafor-mcp sunucusu ──▶ runner (ayrık süreç) ──▶ adaptör ──▶ Codex / diğer işçiler
        ▲   plugin: hook'lar,          │  durum makinesi, şema doğrulama,             │
        └── komutlar, talimatlar       └─ SQLite (.anafor/state.db)                    └─ git worktree
```

## Gereksinimler

- Node.js 24+
- Claude Code
- En az bir işçi: [Codex CLI](https://github.com/openai/codex)

## Geliştirme

```bash
npm install
npm run check   # biçim + tip + test
npm run build
```

Katkı kuralları: [CONTRIBUTING.md](CONTRIBUTING.md)

## Lisans

[AGPL-3.0](LICENSE)

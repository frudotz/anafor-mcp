# anafor-mcp

**Anafor**, Claude Code'u *yönetici*, diğer yapay zekâ kodlama ajanlarını (önce OpenAI Codex CLI) *işçi* yapan bir orkestrasyon sistemidir.

- Claude planlar, işi parçalar, işçiye dağıtır, sonucu inceler ve kabul eder.
- İşçiler izole çalışma alanlarında görevleri yürütür ve **JSON Schema ile doğrulanan** yapılandırılmış sonuç döner.
- İletişim, tipli **MCP araçlarıyla** kurulur. Kurallar (düzenleme yasağı, kabul kapıları, yetki politikası) prompt'ta değil, kodda uygulanır.
- Yeni bir yapay zekâ eklemek, bir `WorkerAdapter` yazmak kadar kolaydır.

> **Durum:** v0.1. Claude Code → Anafor MCP → Codex akışı, yönetici disiplini hook'ları ve kabul kapıları çalışıyor. Worktree paralelliği çalışıyor; ikinci işçi sıradaki fazda.

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

## Hızlı başlangıç

```bash
git clone https://github.com/frudotz/anafor-mcp && cd anafor-mcp
npm install && npm run build

cd /path/to/projen            # bir git deposu olmalı
node /path/to/anafor-mcp/dist/cli/main.js init     # .anafor/ ve .mcp.json oluşturur
node /path/to/anafor-mcp/dist/cli/main.js doctor   # node, git, sqlite, işçiler
claude                         # Claude Code, .mcp.json'daki "anafor" sunucusunu yükler
```

Claude Code içinde örnek istek: *"Anafor ile görev aç, Codex'e dağıt, bitince sonucu incele."*

### MCP araçları (v0.1)

| Araç | İşlev |
|---|---|
| `workers_list`, `project_status` | İşçiler ve proje panosu |
| `task_create`, `task_status` | Kabul kriterli görev |
| `job_dispatch` | İşi işçiye verir; hemen `job_id` döner, iş ayrık süreçte sürer |
| `job_wait`, `job_status`, `job_events` | En fazla 50 sn bekleme, durum, olay günlüğü |
| `job_result` | Şemayla doğrulanmış sonuç, token kullanımı, artefakt yolları |
| `job_request_changes` | Bulgularla, aynı işçi oturumunda düzeltme (görev başına en fazla 5) |
| `job_cancel` | İptal ve süreç ağacını sonlandırma |
| `job_diff` | İş başlangıcındaki HEAD'e göre fark ve işçi raporuyla uyuşmazlıklar |
| `task_accept` | Kabul kapıları (testler, eksik gereksinim, kritik bulgu, kanıt; deep'te bağımsız review) |
| `task_close` | Görevi kabul etmeden kapatma |
| `task_merge` | Kabul edilmiş görev dalını çalışma ağacındaki dala birleştirme (temiz ağaç şartı, çakışmada geri alma) |
| `workspace_cleanup` | Biten işlerin worktree ve birleşmiş dallarını güvenle temizleme |
| `intervene`, `intervene_end` | Pürüz istisnası: süreli ve yol kısıtlı, audit'li doğrudan düzenleme izni |

### Paralel çalışma: git worktree

Git deposunda `implementation` ve `test` işleri varsayılan olarak **kendi worktree'lerinde** çalışır:

```
main (senin çalışma ağacın: dokunulmaz)
 └─ anafor/<görev>              görev dalı
     ├─ anafor/<görev>-<iş1>    .anafor/worktrees/<iş1>
     └─ anafor/<görev>-<iş2>    .anafor/worktrees/<iş2>
```

- Düzeltme ve devam işleri aynı worktree'de, aynı işçi oturumunda sürer.
- `review` işi `target_job_id` ile hedef işin worktree'sini salt okunur inceler.
- `task_accept` değişiklikleri iş dalına commit edip görev dalına birleştirir; `task_merge` görev dalını senin dalına alır.
- Yeni worktree'de bağımlılık kurulumu için: `anafor.config.json` → `"worktree_setup": "npm ci"`.

### Claude Code plugin'i (yönetici disiplini)

```bash
claude --plugin-dir /path/to/anafor-mcp/plugin
```

- **PreToolUse hook:** Anafor projelerinde Claude'un kod dosyalarını doğrudan düzenlemesini ve dosya değiştiren shell komutlarını engeller, işi `job_dispatch`'e yönlendirir. Dokümantasyon ve hafıza yolları serbesttir. Mod: `anafor.config.json` → `"director_mode": "enforce" | "warn" | "off"`.
- **SessionStart hook:** oturum başında rol hatırlatması ve görev panosu.
- **Komutlar:** `/anafor:plan`, `/anafor:run`, `/anafor:status`, `/anafor:accept`.

## Geliştirme

```bash
npm install
npm run check   # biçim + tip + build + test
ANAFOR_E2E_CODEX=1 npx vitest run -t Codex   # gerçek Codex ile uçtan uca (isteğe bağlı)
npm run build
```

Katkı kuralları: [CONTRIBUTING.md](CONTRIBUTING.md)

## Lisans

[AGPL-3.0](LICENSE)

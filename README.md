🇬🇧 [English](README.en.md)

# anafor-mcp

**Anafor**, frontier yapay zekâ modelleri için bir orkestrasyon MCP sunucusudur: bir yönetici ajan işi planlar, işçi ajanlara dağıtır, sonucu kabul kapılarıyla sınar. Hangi modelin hangi rolü üstleneceği yapılandırılabilir.

## Kullanım sınırı

Anafor kişisel ve yerel kullanım içindir: kendi hesabınızda ve makinenizde, resmi ve değiştirilmemiş CLI'larla çalışır; kimlik bilgisi veya oturum token'ı okumaz, saklamaz ya da aktarmaz ve limit atlatmaz. Anafor'u aboneliğiniz üzerinden başkalarına barındırılmış hizmet olarak sunmayın. Yüksek paralellik sağlayıcı kısıtlamalarına yol açabilir. Sağlayıcı koşulları için [kullanım kılavuzuna](docs/kullanim.md#8b-işçiler-ve-kullanım-koşulları) bakın.

- Claude planlar, işi parçalar, işçiye dağıtır, sonucu inceler ve kabul eder.
- İşçiler izole çalışma alanlarında görevleri yürütür ve **JSON Schema ile doğrulanan** yapılandırılmış sonuç döner.
- İletişim, tipli **MCP araçlarıyla** kurulur. Kurallar (düzenleme yasağı, kabul kapıları, yetki politikası) prompt'ta değil, kodda uygulanır.
- Yeni bir yapay zekâ eklemek, bir `WorkerAdapter` yazmak kadar kolaydır.

> **Durum:** v0.5. Claude Code yönetici; Codex, Claude Haiku, OpenCode, Gemini, Antigravity ve yerel model işçileri; worktree paralelliği, kabul ve yönetişim kapıları, kapasite modeli ve yük dengeleyici, token optimizasyonu, SkillSpector eklenti kapısı, Türkçe/İngilizce arayüz, `anafor update`.

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

> **AI agents:** to install or repair Anafor for a user, follow [docs/agent-install.md](docs/agent-install.md) (English, step by step, with `anafor doctor --json` codes).

## Hızlı başlangıç (yeni bilgisayar)

```bash
npm install -g https://github.com/frudotz/anafor-mcp/releases/latest/download/anafor-mcp.tgz   # Node 24+, git, Claude Code ve en az bir işçi gerekir
cd /projen && anafor setup                   # sihirbaz: işçiler, kalıcı plugin, statusline, proje
anafor chat                                  # beyin ajanla terminalden konuş
```

Ayrıntı: **[docs/kurulum.md](docs/kurulum.md)**.

Claude Code içinde örnek istek: *"Anafor ile görev aç, bir işçiye dağıt, bitince sonucu incele."*

### MCP araçları (v0.1)

| Araç | İşlev |
|---|---|
| `workers_list`, `project_status` | İşçiler ve proje panosu |
| `task_create`, `task_status` | Kabul kriterli görev |
| `job_dispatch` | İşi işçiye verir; hemen `job_id` döner, iş ayrık süreçte sürer |
| `job_wait`, `job_status`, `job_events` | Kısa (en fazla 50 sn) bekleme, durum, olay günlüğü |
| `job_result` | Şemayla doğrulanmış sonuç, token kullanımı, artefakt yolları |
| `job_request_changes` | Bulgularla, aynı işçi oturumunda düzeltme (görev başına en fazla 5) |
| `job_cancel` | İptal ve süreç ağacını sonlandırma |
| `job_diff` | İş başlangıcındaki HEAD'e göre fark ve işçi raporuyla uyuşmazlıklar |
| `task_accept` | Kabul kapıları (testler, eksik gereksinim, kritik bulgu, kanıt; deep'te bağımsız review) |
| `task_close` | Görevi kabul etmeden kapatma |
| `task_merge` | Kabul edilmiş görev dalını çalışma ağacındaki dala birleştirme (temiz ağaç şartı, çakışmada geri alma) |
| `workspace_cleanup` | Biten işlerin worktree ve birleşmiş dallarını güvenle temizleme |
| `intervene`, `intervene_end` | Pürüz istisnası: süreli ve yol kısıtlı, audit'li doğrudan düzenleme izni |
| `checkpoint`, `operation_authorize`, `operation_record` | Yönetişim: git durumu kaydı, politika ve kanıt kapısı, append-only audit |
| `memory_lock`, `memory_metrics` | Lat.md hafızası için münhasır yazma kirası ve ölçümler |

Uzun işler için `anafor job wait <id>` komutunu Claude Code'da Bash `run_in_background` ile çalıştırın; iş bitince harness yöneticiyi uyandırır. `job_wait` MCP aracı kısa kontroller içindir.

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
- Yeni worktree'de bağımlılık kurulumu için: `anafor.config.json` → `"worktree_setup": "npm ci"`. Daha hızlısı: `"worktree_cache": { "paths": ["node_modules"], "key_files": ["package-lock.json"] }` (kilit dosyası aynıysa hardlink kopya, kurulum atlanır).

### İşçiler ve yönlendirme

| İşçi | Çalıştırma | Not |
|---|---|---|
| `codex` | `codex exec --json --output-schema` | Varsayılan uygulama işçisi |
| `cirak` | `claude -p --model haiku --json-schema` | Ucuz analiz, test ve çapraz inceleme; MCP yüklenmez, izin atlatma yok |
| `fake` | deterministik betik | Test ve kuru çalıştırma |

`job_dispatch` işçi belirtilmezse rolün tercih sırasından ilk uygun işçiyi seçer. Review işinde, hedef işi yapandan **farklı** bir işçi tercih edilir. Ayarlar:

```json
{
  "routing": { "implementation": ["codex", "cirak"], "review": ["codex", "cirak"] },
  "workers": { "cirak": { "model": "haiku", "max_concurrency": 3 }, "codex": { "enabled": true } }
}
```

Yeni bir işçi eklemek: `WorkerAdapter` uygulayan bir sınıf + `src/adapters/registry.ts`'e bir satır. Uyum testi: `test/integration/conformance.test.ts`.

### Claude Code plugin'i (yönetici disiplini)

```bash
claude --plugin-dir /path/to/anafor-mcp/plugin
```

- **PreToolUse hook:** Anafor projelerinde Claude'un kod dosyalarını doğrudan düzenlemesini ve dosya değiştiren shell komutlarını engeller, işi `job_dispatch`'e yönlendirir. Dokümantasyon ve hafıza yolları serbesttir. Mod: `anafor.config.json` → `"director_mode": "enforce" | "warn" | "off"`.
- **SessionStart hook:** oturum başında rol hatırlatması ve görev panosu.
- **Komutlar:** `/anafor:plan`, `/anafor:run`, `/anafor:status`, `/anafor:accept`.

Ayrıntılı kılavuz: **[docs/kullanim.md](docs/kullanim.md)**. Eski `software-orchestrator` durumundan göç: `anafor migrate`.

## Geliştirme

```bash
npm install
npm run check   # biçim + tip + build + test
ANAFOR_E2E_CODEX=1 ANAFOR_E2E_CLAUDE=1 npx vitest run test/integration/conformance.test.ts   # gerçek işçilerle uyum (isteğe bağlı)
npm run build
```

Katkı kuralları: [CONTRIBUTING.md](CONTRIBUTING.md)

## Güvenlik: işçi yapılandırma yalıtımı

Codex isolate modunda kullanıcı MCP/plugin/skill yapılandırmalarından yalıtılır. cirak yalnızca slash komutlarını/skill'leri kapatır (`--disable-slash-commands`) ve dış MCP yapılandırmasını yüklemez (`--strict-mcp-config`); kullanıcının hook ve diğer ayarları etkin kalır. `workers.<id>.user_config: "inherit"`, ilgili işçi için Codex yalıtımını veya cirak slash komutu kapatmasını kaldırır. Ayrıntılar için [kullanım kılavuzuna](docs/kullanim.md) bakın.

## Lisans, çatallar ve atıf

Anafor [AGPL-3.0-only](LICENSE) lisanslıdır. Çatallamak (fork), değiştirmek ve kendi yol haritanızla geliştirmek serbesttir. Bunu yaparken uymanız gereken koşullar:

- **`LICENSE` ve [`NOTICE`](NOTICE) dosyalarını koruyun.** NOTICE, AGPL-3.0 §7(b) kapsamında **orijinal kaynağın ve asıl geliştiricilerin** (https://github.com/frudotz/anafor-mcp, frudotz ve RedRiveRR) README'nizde ve `anafor version` çıktısında belirtilmesini şart koşar.
- **Değişiklikleri işaretleyin (§5(a)).** Değiştirilmiş bir sürümü orijinal Anafor gibi sunmayın.
- **Türetilmiş çalışmalar da AGPL-3.0 ile lisanslanır.** Değiştirilmiş bir sürümü ağ üzerinden başkalarına sunuyorsanız (örneğin bir MCP sunucusu olarak), o kullanıcılara kaynak kodunu sağlamanız gerekir (§13).
- **Düzeltmeleri geri gönderin.** Çatalınızda düzelttiğiniz hataları ana repoya PR olarak gönderirseniz herkes yararlanır: [docs/sharing-fixes.md](docs/sharing-fixes.md).

Bu bölüm hukuki tavsiye değildir; bağlayıcı metin [LICENSE](LICENSE) dosyasıdır.

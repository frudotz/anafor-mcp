# Anafor kullanım kılavuzu

Anafor, Claude Code'u **yönetici** yapar: Claude planlar, işi parçalar, işçilere (Codex, Claude Haiku…) dağıtır, sonucu inceler ve kabul eder. Kod dosyalarını kendisi düzenlemez; bu kural bir hook ile uygulanır.

## 1. Kurulum

```bash
git clone https://github.com/frudotz/anafor-mcp
cd anafor-mcp && npm install && npm run build
```

Gereksinimler: Node 24+, git, Claude Code ve en az bir işçi:

- Codex CLI (`codex login`)
- Claude Code'un kendisi (`claude-lite` işçisi için ek kurulum gerekmez)

## 2. Bir projeyi Anafor'a bağlama

```bash
cd /projen                         # en az bir commit'i olan bir git deposu
node /yol/anafor-mcp/dist/cli/main.js init      # .anafor/, policy.json, .gitignore, .mcp.json
node /yol/anafor-mcp/dist/cli/main.js doctor    # node, git, sqlite, işçiler
claude --plugin-dir /yol/anafor-mcp/plugin      # yönetici hook'ları + /anafor:* komutları
```

> `--plugin-dir` kullanıyorsan `.mcp.json`'a gerek yoktur; plugin kendi MCP sunucusunu getirir. Yalnızca MCP istiyorsan (hook olmadan) `claude` yeterlidir.

## 3. Günlük akış

| Adım | Komut veya araç |
|---|---|
| Plan | `/anafor:plan <hedef>`: analiz → görevler + kabul kriterleri → onay |
| Dağıt | `/anafor:run`: `job_dispatch` → `job_wait` → `job_result` / `job_diff` |
| Düzelt | `job_request_changes` (aynı işçi oturumu, görev başına en fazla 5) |
| Kabul | `/anafor:accept <görev> <iş>`: `task_accept` kapıları; worktree işi görev dalına birleşir |
| Dalına al | `task_merge`: görev dalı → çalışma ağacındaki dal (temiz ağaç şartı) |
| Temizle | `workspace_cleanup` |
| Durum | `/anafor:status` |

### İş durumları

`queued → starting → running → validating → needs_review → approved → merged`

Hata durumları: `failed`, `timed_out`, `cancelled`, `invalid_output` (işçi şemaya uymayan çıktı verdi).

Sunucu yeniden başlarsa ölü işler `failed (orphaned)` olur. **Hiçbir iş otomatik olarak yeniden çalıştırılmaz.**

## 4. Yönetici disiplini

- Claude'un Anafor projesindeki kod dosyalarını `Edit`/`Write` ile düzenlemesi ve dosya değiştiren shell komutları **engellenir**. Gerekçe Claude'a iletilir ve `.anafor/audit/interventions.jsonl`'e yazılır.
- Serbest olanlar: okuma, test, build, git/gh yönetim komutları, `*.md`, `docs/`, `lat.md/`.
- **Pürüz istisnası:** `intervene` (gerekçe + yollar + en fazla 30 dk) → düzenle → `intervene_end` (özet). Tümü audit'lenir.
- **Görev devralma (takeover):** işçiler tekrar tekrar başarısız olursa (varsayılan: 3 başarısız veya reddedilen iş), görev `blocked` olursa ya da bir iş 60 dakikadan uzun sürerse Claude `task_takeover` ile görevi devralır. Aktif işler iptal edilir; Claude yalnızca o görevin worktree'sinde, süreli izinle çalışır. Bitince `takeover_complete` → `task_accept`. Eşikler: `anafor.config.json` → `"escalation": { "failure_threshold": 3, "stall_minutes": 60, "takeover_minutes": 120 }`.
- İşçi worktree'leri (`.anafor/worktrees/`) hiçbir `allow_paths` kuralıyla açılamaz; yalnızca izinle düzenlenebilir.
- Mod: `anafor.config.json` → `"director_mode": "enforce" | "warn" | "off"`.

## 5. Yapılandırma (`anafor.config.json`)

```json
{
  "director_mode": "enforce",
  "allow_paths": ["lat.md/**", "docs/**", "**/*.md"],
  "default_worker": "codex",
  "worktree_setup": "npm ci",
  "routing": {
    "implementation": ["codex", "claude-lite"],
    "test": ["claude-lite", "codex"],
    "analysis": ["claude-lite", "codex"],
    "review": ["codex", "claude-lite"]
  },
  "workers": {
    "codex": { "max_concurrency": 2 },
    "claude-lite": { "model": "haiku", "max_concurrency": 3 },
    "fake": { "enabled": false }
  }
}
```

`.anafor/config.json` yerel ezmeler içindir (commit edilmez). Proje dosyası önceliklidir.

## 6. Yönetişim (commit, push, merge, deploy)

1. `checkpoint`: git durumunun kaydı. Çalışma ağacını değiştirmez.
2. `operation_authorize`: `.anafor/policy.json` + kanıt dosyaları + checkpoint tazeliği. Kanıtları **`.anafor/evidence/`** altına yazın (proje içi, git'e girmez, hook serbest bırakır).
   - Varsayılan politika: otonom commit açık; push, PR, merge ve deploy allowlist'leri **boş** (ret); üretim kapalı.
   - Korumalı riskler (üretim veri kaybı, geri alınamaz değişiklik, güvenlik/erişim politikası, plan dışı maliyet) **her zaman** açık kullanıcı onayı ve kanıtı ister.
3. İşlemi projenin normal araçlarıyla yap.
4. `operation_record`: başarılı, başarısız ve engellenen her deneme append-only `.anafor/audit/operations.jsonl`'e yazılır.

Yıkıcı otomatik kurtarma (`reset --hard`, force push, toplu silme) yapılmaz. Geri alma `git revert` iledir.

## 7. Proje hafızası (Lat.md, isteğe bağlı)

- `memory_lock acquire` → `lat.md/` güncelle → `lat check` → `memory_lock release` (token ile). Kira kendiliğinden düşmez.
- `memory_metrics`: kısa maskelenmiş etiket. Token sayıları yalnızca işçi veya CLI gerçek değer raporladığında yazılır.

## 7b. Oturum ve kullanım limitleri

```bash
node /yol/anafor-mcp/dist/cli/main.js limits
# codex        ok       5s %10 (Sal 01:55) · 7g %38 (Cmt 19:49)
# claude       warning  5s %84 · 7g %26
```

MCP aracı: `workers_limits`. Kaynaklar (yalnızca resmi araçların kendi verdiği bilgiler; kimlik bilgisine dokunulmaz):

| İşçi | Kaynak |
|---|---|
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` içindeki son `token_count.rate_limits` |
| Claude (beyin ve claude-lite) | `claude-lite` işlerindeki `rate_limit_event` + Claude Code statusline girdisi |
| Antigravity, OpenCode, yerel | Araç limit bildirmiyor → `unknown` |

Beyin oturumunun limitlerini de görmek için Claude Code ayarlarına (`~/.claude/settings.json`) ekleyin:

```json
{ "statusLine": { "type": "command", "command": "node /yol/anafor-mcp/dist/cli/main.js statusline" } }
```

Router, bir penceresi %100 dolmuş (ve henüz sıfırlanmamış) işçiyi atlar.

## 8. Eski software-orchestrator'dan göç

```bash
node /yol/anafor-mcp/dist/cli/main.js migrate /projen
```

`.orchestrator/` **salt okunur** kopyalanır: politika (yeni proje kimliğine bağlanır), görev tarihçesi, audit, checkpoint'ler ve metrikler. İşçi oturumları taşınmaz. Tekrar çalıştırılırsa reddeder.

## 9. Yeni bir işçi eklemek

1. `src/adapters/<işçi>.ts`: `WorkerAdapter` (`detect`, `capabilities`, `start`, isteğe bağlı `resume`). Olayları `WorkerEvent`'e çevir; son mesaj `WorkerResult v1` JSON'u olmalı.
2. `src/adapters/registry.ts`'e bir satır ekle.
3. `anafor.config.json` → `routing`.
4. `test/integration/conformance.test.ts`'e bir satır ekle ve gerçek işçiyle çalıştır.

## 10. Sorun giderme

| Belirti | Çözüm |
|---|---|
| `NOT_INITIALIZED` | Proje kökünde `anafor init` |
| `WORKER_UNAVAILABLE` | `anafor doctor`; `codex login`; `workers_list` nedenleri |
| `invalid_output` | `job_events` / `.anafor/jobs/<iş>/stdout.log`; işçi şemaya uymadı, yeniden dağıt |
| `CONFLICT` (shared) | Paylaşılan alanda tek yazan iş; worktree kullan |
| `task_merge` CONFLICT | İzlenen dosyalarda commit edilmemiş değişiklik var; commit veya stash. İzlenmeyen dosyalar engellemez |
| `task_merge` çakışma | Birleştirme geri alındı; çakışan dosyalar için düzeltme işi dağıt veya `intervene` |
| Hook her şeyi engelliyor | `anafor.config.json` → `director_mode: "warn"` (geçici) |

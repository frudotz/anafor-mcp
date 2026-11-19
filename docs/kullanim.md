🇬🇧 English: [usage.md](en/usage.md)

# Anafor kullanım kılavuzu

Anafor, frontier yapay zekâ modelleri için bir orkestrasyon MCP sunucusudur: yönetici ajan işi planlar, işçilere dağıtır, sonucu inceler ve kabul eder. Hangi modelin hangi rolü üstleneceği yapılandırılabilir. Yönetici kod dosyalarını kendisi düzenlemez; bu kural bir hook ile uygulanır.

## 1. Kurulum

```bash
git clone https://github.com/frudotz/anafor-mcp
cd anafor-mcp && npm install && npm run build
```

Gereksinimler: Node 24+, git, Claude Code ve en az bir işçi:

Kalitenin önemli olduğu orta ölçekli işlerde doğrudan Opus tek ajan daha iyi sonuç verdi (F32); Anafor paralel büyük işler, Claude limiti darboğazı ve yönetişimli akış için.

- Codex CLI (`codex login`)
- Claude Code'un kendisi (`cirak` işçisi için ek kurulum gerekmez)

## 2. Bir projeyi Anafor'a bağlama

```bash
cd /projen                         # en az bir commit'i olan bir git deposu
node /yol/anafor-mcp/dist/cli/main.js init      # .anafor/, policy.json, .gitignore, .mcp.json
node /yol/anafor-mcp/dist/cli/main.js init --exclude-local  # .anafor/ öğesini ortak git info/exclude dosyasına ekler
node /yol/anafor-mcp/dist/cli/main.js doctor    # node, git, sqlite, işçiler
# Windows'ta Codex işi MCP `job_dispatch` ile başlatıldıktan sonra doğrula: `anafor job wait <job-id>; Get-Content .anafor/env-probe.json | ConvertFrom-Json` JSON döndürmelidir.
claude --plugin-dir /yol/anafor-mcp/plugin      # yönetici hook'ları + /anafor:* komutları
```

> `--plugin-dir` kullanıyorsan `.mcp.json`'a gerek yoktur; plugin kendi MCP sunucusunu getirir. Yalnızca MCP istiyorsan (hook olmadan) `claude` yeterlidir.

## 2b. Terminal CLI modu (beyin ajanla konuşma)

Claude Code'u açmadan, Anafor'un kendi terminalinden beyin ajanla konuşabilirsin:

```bash
cd /projen
anafor chat                 # kalıcı oturum (.anafor/brain.json); --new ile sıfırdan
anafor run "hedef"           # yalın beyin oturumu
anafor chat --once "Açık görevleri özetle"     # tek mesaj, etkileşimsiz
anafor jobs [--all]         # görev ve iş panosu
anafor watch                # canlı iş olayları
anafor roles                # beyin ve işçi rolleri
anafor roles set review codex,local,cirak
anafor limits               # işçi oturum/kullanım limitleri
```

- **Beyin**: `anafor chat` resmi `claude` ikilisini kullanıcı ayarlarıyla açar. `anafor run` ve `anafor loop` varsayılan olarak yalın modda yalnız Anafor MCP ve `Read`, `Grep`, `Glob`, `Bash` araçlarını yükler; diğer MCP sunucuları, skill'ler ve slash komutları devre dışıdır.
- Sohbette beyin mesajları, çağırdığı araçlar (`⚙`) ve işçi olayları (`↳`) **canlı** görünür. Sohbet içi komutlar: `/jobs`, `/limits`, `/izinler`, `/cikis`.
- **İzinler:** önceden izinli olmayan bir araç gerektiğinde (ör. `npm test`) beyin, `permission_prompt` aracı üzerinden sana sorar: `[e]vet / [h]ayır / [d]aima`. Yanıt gelmezse istek reddedilir. `--once` modunda istekler otomatik reddedilir. Claude Code ayarlarındaki izin modun (ör. `auto`) geçerlidir; değiştirmek için `--permission-mode manual`.
- Oturum devam eder: `anafor chat` her çalıştığında aynı beyin oturumunu sürdürür.

Headless beyin ayarları `anafor.config.json` içindeki `brain` nesnesindedir. `lean` varsayılanı `true`'dur; `false` eski plugin davranışını açar. `model` ve `effort` isteğe bağlıdır; `anafor run --model MODEL` ve loop için `--model MODEL` config modelini geçersiz kılar.

```json
{ "brain": { "lean": true, "model": "claude-sonnet-4-5", "effort": "medium" } }
```

### Headless mod

```bash
anafor run "Stack sınıfına clear() ekle ve testini yaz" --accept --merge --worker codex
```

Beyin hedefi kullanıcı olmadan baştan sona yürütür: plan → dağıt → incele → (isteğe bağlı) kabul → kanıt → yetki → birleştirme → audit → temizlik. İzin isteyen her şey reddedilir. `--accept` olmadan kabul edilmez, `--merge` olmadan birleştirilmez. Agent SDK gerekmez; resmi `claude` ikilisi kullanılır.

### Geliştirme döngüsü (`anafor loop`)

Döngü, resmi `claude` ikilisiyle tek bir beyin oturumu açar. Her turda yöneticiye
hedefi veya sıradaki backlog maddesini prompt olarak verir; `ANAFOR_LOOP` işaretiyle
tamamlanma, devam veya engel bildirilir. Limit yaklaşınca yeni büyük iş açmak yerine
mevcut işi güvenli noktaya getirmesi istenir.

```bash
anafor loop start "hedef" [--auto-resume] [--max-cycles N] [--until ISO]
anafor loop start --backlog backlog.md [--profile saver|balanced|quality]
anafor loop status
anafor loop pause | resume | stop
```

Ek başlangıç bayrakları: `--accept`, `--merge`, `--model M`; `--detach` döngüyü
ayrık süreçte başlatır. `--accept` ve `--merge` açıkça verilmedikçe kabul veya
birleştirme yapılmaz. MCP'de `loop_start` hedef ya da backlog ile aynı seçenekleri
alır; `loop_status` durumu ve backlog ilerlemesini, `loop_stop` duraklatma veya
durdurmayı sağlar. Claude Code'da `/anafor:loop <hedef>` komutu da `loop_start`
kullanır.

Limit eşikleri `anafor.config.json` içindeki `limits.brain` ile ayarlanır:
varsayılan `warn_at: 75`, `pause_at: 90`, `pause_at_weekly: 95` (yüzde). Eşik
aşılınca döngü tur sonunda duraklar, checkpoint oluşturur ve `resume_at` zamanını
durum dosyasına yazar. `--auto-resume` kullanıcı tercihidir; verilmezse otomatik
devam etmez. Duraklamış işi `anafor loop resume` ile elle sürdürün. `pause` ve
`stop` isteği mevcut tur bitince geçerli olur.

Backlog dosyası proje kökünden okunur; tamamlanan satırlar `- [ ] madde` biçiminde
olmalıdır. Örnek:

```markdown
- [ ] Kullanıcı kayıt akışını incele
- [ ] Testleri ekle ve sonucu doğrula
```

Her turun son yanıtı bir `ANAFOR_LOOP` işareti taşımalıdır:
`ANAFOR_LOOP: DONE`, `ANAFOR_LOOP: CONTINUE` veya `ANAFOR_LOOP: BLOCKED <neden>`.
Durum satırında çalışan döngü `↻ döngü #N`, otomatik devamı bekleyen döngü
`⏸ döngü: <saat>'te devam`, elle devam bekleyen döngü ise
`⏸ döngü durakladı: anafor loop resume` olarak görünür. UserPromptSubmit hook'u
Claude limiti uyarı eşiğini aşınca işi güvenli noktaya getirmesi için kısa not ekler.

Öneri: sonraki adımları önceden bir belge, kasa (checkpoint) veya backlog dosyasında
belirleyin. Döngü limitlere uyar ve bunları atlatmaz; paralel beyin başlatmaz, tek
beyin oturumunu sürdürür ve resmi `claude` ikilisini kullanır. Bu hukuki görüş
değildir; sağlayıcıların güncel koşullarını ayrıca inceleyin.

## 3. Günlük akış

| Adım | Komut veya araç |
|---|---|
| Plan | `/anafor:plan <hedef>`: analiz → görevler + kabul kriterleri → onay |
| Dağıt | `/anafor:run`: `job_dispatch` → uzun işte arka plan `anafor job wait <id>` → `job_result` / `job_diff` |

Uzun işleri beklemek için Claude Code'da Bash `run_in_background` kullanarak `anafor job wait <id>` çalıştırın; bitince harness yöneticiyi uyandırır. MCP `job_wait` aracı en fazla 50 saniyelik kısa kontroller içindir.
| Düzelt | `job_request_changes` (aynı işçi oturumu, görev başına en fazla 5) |
| Kabul | `/anafor:accept <görev> <iş>`: `task_accept` kapıları; worktree işi görev dalına birleşir. Standard/deep görevlerde güncel bağımsız review gerekir; review'da medium+ bulgu veya eksik kabul ölçütü varsa, review sonrası `auto_check`'i geçen düzeltme olmadan kabul edilmez. Low/info bulgular `open_low_findings` alanında bildirilir. İşçi testleri çalıştıramadıysa (ör. sandbox): `evidence_generate` → `task_accept` + `verified_by_evidence_reason` |
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
  "routing_mode": "static",
  "worktree_setup": "npm ci",
  "worktree_cache": { "paths": ["node_modules"], "key_files": ["package-lock.json"] },
  "routing": {
    "implementation": ["codex", "cirak"],
    "test": ["cirak", "codex"],
    "analysis": ["cirak", "codex"],
    "review": ["codex", "cirak"]
  },
  "workers": {
    "codex": { "max_concurrency": 2, "windows_sandbox": "elevated" },
    "cirak": { "model": "haiku", "max_concurrency": 3 },
    "fake": { "enabled": false }
  }
}
```

`worktree_cache` yeni worktree'de `worktree_setup` yerine bağımlılık dizinini ana çalışma ağacından **hardlink** ile çoğaltır. Koşullar: `key_files` (ör. `package-lock.json`) iki ağaçta birebir aynı olmalı, dizin gitignore'da olmalı ve kaynakta symlink/junction bulunmamalı. Koşul sağlanmazsa olay günlüğüne nedeni yazılır ve normal `worktree_setup` çalışır. Junction kullanılmaz, çünkü `git worktree remove` junction'ın hedefini (ana projenin `node_modules`'ünü) siler.

`max_parallel_jobs` (varsayılan 4) **makine genelinde** aynı anda çalışabilecek toplam iş sayısıdır: tüm işçiler ve tüm projeler sayılır. Her çalışan runner `~/.anafor/running/` altında süreç kimlikli bir kira bırakır; ölü süreçlerin kiraları sayılmaz. Sınır doluysa `job_dispatch` `LIMIT_REACHED` döner. Anlık kullanım `project_status.parallel` alanında görünür. İşçi başına sınır ayrıca `workers.<id>.max_concurrency` ile verilir.

`.anafor/config.json` yerel ezmeler içindir (commit edilmez). Proje dosyası önceliklidir.

### İşçi CLI yapılandırma yalıtımı

Codex varsayılan olarak `workers.codex.user_config: "isolate"` kullanır. `--ignore-user-config` ile başlar; kişisel `~/.codex/config.toml` (veya `CODEX_HOME`) içinden yalnızca `model` (özel provider yoksa), `model_reasoning_effort` ve Windows `sandbox` ayarları aktarılır. İş emrindeki model/effort ve `workers.codex.windows_sandbox` bu değerleri ezer. Kişisel MCP, plugin ve proje ayarları aktarılmaz. İzolasyonda web arama, uygulama bağlayıcıları ve görsel üretim kapalıdır. Kullanıcının `sandbox_workspace_write.network_access` ayarı da taşınmaz; sandbox ağ erişimi varsayılan olarak kapalıdır. Bu ayarları ve ağ erişimini işçiye açmanız gerekiyorsa Codex için `inherit` kullanın. codex-cli 0.167.2 ile yapılan ölçümde yaklaşık %22 daha az ilk tur girdi token'ı (16,8K → 13,1K), `--ignore-user-config` tek başına değil, uygulama bağlayıcıları, görsel üretim ve web arama kapatıldığında görüldü; tek başına config yoksayma ölçümünde fark yoktu.

cirak varsayılan olarak `--disable-slash-commands` ile slash komutlarını/skill'leri kapatır, `--strict-mcp-config` ile harici MCP yapılandırmasını yüklemez. Kullanıcının hook'ları ve diğer Claude Code ayarları etkin kalır. `workers["cirak"].user_config: "inherit"` yalnızca slash komutlarını kapatma bayrağını kaldırır; strict MCP yapılandırması korunur.

Kişisel CLI yapılandırmasını bilinçli olarak devralmak için ilgili işçide `"user_config": "inherit"` ayarlayın; örneğin `"workers": { "codex": { "user_config": "inherit" } }`. Bu ayar Codex için kullanıcı config yalıtımını, cirak için slash komutlarını kapatma bayrağını kaldırır.

`routing_mode` varsayılan olarak `static` kalır ve `routing` listesini aynen kullanır. `adaptive` seçildiğinde, aynı rolde en az üç bitmiş işi olan işçiler kabul oranına göre öne alınır; daha az geçmişi olanlar listede bulundukları konumu korur. `worker_stats` MCP aracı (isteğe bağlı `role` filtresiyle) kabul, hata, değişiklik isteği, süre ve token ortalamalarını gösterir.

## 6. Yönetişim (commit, push, merge, deploy)

1. `checkpoint`: git durumunun kaydı. Çalışma ağacını değiştirmez.
2. `operation_authorize`: `.anafor/policy.json` + kanıt dosyaları + checkpoint tazeliği. Kanıtları **`.anafor/evidence/`** altına yazın (proje içi, git'e girmez, hook serbest bırakır).
   - Varsayılan politika: otonom commit açık; push, PR, merge ve deploy allowlist'leri **boş** (ret); üretim kapalı.
   - Korumalı riskler (üretim veri kaybı, geri alınamaz değişiklik, güvenlik/erişim politikası, plan dışı maliyet) **her zaman** açık kullanıcı onayı ve kanıtı ister.
3. İşlemi projenin normal araçlarıyla yap.
4. `operation_record`: başarılı, başarısız ve engellenen her deneme append-only `.anafor/audit/operations.jsonl`'e yazılır.

Yıkıcı otomatik kurtarma (`reset --hard`, force push, toplu silme) yapılmaz. Geri alma `git revert` iledir.

## 7. Proje hafızası (Lat.md, isteğe bağlı)

- **Otomatik bağlam:** projede `lat.md/` varsa her yeni işin emrine görevle ilgili bölümler eklenir ("Proje hafızası"). Seçim `lat search` ile yapılır (çevrimdışı hibrit arama, en fazla 4 bölüm, ~4000 karakter). `lat` kurulu değilse yerleşik anahtar kelime araması kullanılır. Düzeltme ve devam işlerinde eklenmez, çünkü o oturumda bağlam zaten var. Kapatmak için: `"memory_context": false`. Olay günlüğünde `memory` olayı ve `memory_metrics` kaydı oluşur.

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
| Codex | `codex app-server` içindeki salt okunur `account/rateLimits/read`; erişilemezse rollout yedeği. `anafor limits --refresh` canlı yeniler, statusline önbelleği en fazla 5 dakikada bir arka planda yeniler. |
| Claude (beyin ve cirak) | `cirak` işlerindeki `rate_limit_event` + Claude Code statusline girdisi |
| Antigravity, OpenCode, yerel | Araç limit bildirmiyor → `unknown` |

Beyin oturumunun limitlerini de görmek için Claude Code ayarlarına (`~/.claude/settings.json`) ekleyin:

```json
{ "statusLine": { "type": "command", "command": "node /yol/anafor-mcp/dist/cli/main.js statusline" } }
```

Statusline, Codex limitlerini önbellekten gösterir. Eski gözlemler 30 dakikadan sonra soluk görünür, 24 saatten sonra gizlenir. Varsayılan işçi listesi `codex`'tir; `anafor.config.json` içinde `"statusline": { "workers": [] }` ile kapatılabilir veya başka kayıtlı işçiler eklenebilir.

Router, bir penceresi %100 dolmuş (ve henüz sıfırlanmamış) işçiyi atlar.

## 7c. Kapasite modeli ve rol dağılımı önerisi

`anafor capacity` her hesabı (claude, codex …) limit pencereleriyle gösterir.

**KP (kapasite puanı)** bir pencerenin %1'idir. Boş alan şöyle hesaplanır: `100 − kullanım − rezerv`. Rezerv, senin etkileşimli kullanımın için ayrılan paydır; varsayılan değeri 5 saatlik pencerede %10, haftalık pencerede %15'tir.

**Tempo**, kullanım oranının pencerede geçen süre oranına bölümüdür. Tempo 1'in üstündeyse pencere süresi bitmeden dolar.

**İş başına maliyet nasıl öğrenilir?** Bir iş, aynı hesapta başka iş çalışmazken bittiğinde, runner pencerenin işten önceki ve sonraki kullanımını karşılaştırır. Aradaki fark ilgili hesap, rol ve pencere için `~/.anafor/capacity-costs.json` dosyasına kaydedilir. Planlamada bu ölçümlerin p80 değeri kullanılır. Bu değerden rol başına "~N iş kaldı" tahmini çıkarılır.

Not: Claude hesabını beyin ile `cirak` paylaşır. Bu yüzden Claude için çıkan maliyetler bir üst sınırdır.

**İpuçları:** Bir pencere rezerve ulaştığında, hızlı tükendiğinde ya da bir rolde 2 veya daha az iş kapasitesi kaldığında `anafor capacity` uyarır. Rolün ilk işçisi kısıtlıysa sağlıklı bir yedek önerir ve bunun için kullanılacak `anafor roles set …` komutunu da verir. Aynı bilgi MCP aracı `capacity_status` ile de alınabilir.

**Önerilen rol dağılımı** dönemsel meta profilinden üretilir (2026-Q4, vault'taki F19 araştırması). Örnek:

```bash
anafor capacity recommend claude-max,chatgpt-plus          # öneriyi göster
anafor capacity recommend claude-max,chatgpt-plus --apply  # anafor.config.json → subscriptions + routing
anafor capacity recommend                                  # abonelik kimlikleri listesi
```

Önerinin dayandığı ilkeler:
- Beyin öncü kademede (Opus) çalışır.
- Eşit kademede beynin hesabını paylaşmayan işçi öne alınır.
- İnceleme, uygulayıcıdan farklı bir model ailesine verilir.
- Yerel modeller yalnızca test ve analiz için yedek olarak kullanılır.
- Sağlayıcı koşullarına tabi abonelikli işçiler uyarıyla gösterilir.

Ayarlar (`anafor.config.json`):

```json
{
  "subscriptions": ["claude-max", "chatgpt-plus"],
  "capacity": { "reserve_five_hour": 10, "reserve_weekly": 15, "pace_threshold": 1.2 }
}
```

### Yük dengeleyici

Router, rolün tercih zincirini (`routing`) **abonelik kapasitesine göre** yeniden sıralar. Zincirdeki sıra kalite tercihini gösterir. Dengeleyici bu sırayı yalnızca kısıtlı hesapları geri itmek için değiştirir.

| Strateji | Davranış |
|---|---|
| `balanced` (varsayılan) | Rezerve ulaşmış ya da tahmini iş maliyeti boş alana sığmayan hesaplar sona, hızlı tükenenler ortaya alınır. Henüz gözlenmemiş hesaplar nötr sayılır. |
| `protect-brain` | `balanced` + eşit grupta beynin Claude hesabını kullanan işçiler geriye alınır. |
| `cheap-first` | `balanced` + eşit grupta ucuz kademe (`cost_tier`) önce gelir. |
| `off` | Zincir olduğu gibi kullanılır; yalnızca %100 dolu limitler atlanır. |

Dengeleyici sırayı değiştirdiğinde gerekçesi `job_dispatch` uyarılarında ve işin `route` olayında görünür. Örnek: `yük dengeleyici (balanced): codex yerine cirak — codex: five_hour rezerve ulaştı`.

```json
{ "balancer": { "strategy": "protect-brain" } }
```

## 7d. Token optimizasyonu

Bunlar ek ayar gerektirmeden çalışır:

- **Önbellek dostu iş emri:** Aynı roldeki her işte birebir aynı olan kısım (kurallar, rol, çıktı sözleşmesi, şema) iş emrinin başında yer alır. İşe özgü kısım (kimlik, görev, talimat, hafıza) sondadır. Böylece sağlayıcının prompt önbelleği, tekrar eden önek için girdi maliyetini yaklaşık 0,1× seviyesine düşürür.
- **Düzeltme turunda kısa emir:** İşçi oturumu devam ettirildiğinde (resume) görev ve kurallar yeniden gönderilmez. Yalnızca yeni kimlik, talimat ve bulgular eklenir.
- **Özet sınırı:** İşçinin `summary` alanı en fazla 2000 karakter olabilir; aşarsa kırpılır ve uyarı verilir. Böylece yöneticinin bağlamı küçük kalır.
- **Codex telemetrisi kapalı:** Codex işlerine `analytics.enabled=false` geçirilir.

**Token profili.** Her rol için akıl yürütme düzeyini (effort) belirler. Codex'e `model_reasoning_effort`, cirak'a `--effort` olarak geçirilir.

| Profil | implementation | review | analysis | test |
|---|---|---|---|---|
| `saver` | medium | medium | low | low |
| `balanced` (varsayılan) | medium | high | medium | low |
| `quality` | high | high | high | medium |
| `off` | işçinin kendi varsayılanı | | | |

```json
{
  "token_profile": "saver",
  "workers": { "codex": { "effort": { "review": "high" } } }
}
```

`workers.<id>.effort` ya tek bir değer ya da rol başına bir harita olabilir ve profili ezer.
## 7e. Eklenti kapısı (SkillSpector)

Harici skill ve MCP sunucuları, Anafor projelerinde ancak [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) taramasını geçerse kurulabilir ve çalıştırılabilir.

Tarama her zaman `--no-llm` ile yapılır, yani dosya içeriği hiçbir LLM sağlayıcısına gönderilmez. Tek dış çağrı, bağımlılık adlarının OSV.dev'de sorgulanmasıdır.

| SkillSpector sonucu | Karar |
|---|---|
| Tarama hatası | Engellenir (fail-closed) |
| HIGH / CRITICAL (skor > 50, `DO_NOT_INSTALL`) | Engellenir |
| CAUTION (skor 21–50) | Yalnızca `--accept-risk` ile kurulur; onay kayda geçer |
| SAFE (skor 0–20) | Kurulur |

```bash
anafor ext add ./benim-skill                                  # yerel dizin
anafor ext add https://github.com/kurum/skills --path pdf     # git deposundan bir skill
anafor ext add-mcp arama --source https://github.com/kurum/arama-mcp -- npx -y arama-mcp@1.2.3
anafor ext adopt codex-gpt --user                             # zaten kurulu skill'i yerinde tarat
anafor ext check                                              # kurulu olanların durumu
anafor ext list
```

**Kayıt.** Taramayı geçen eklentiler içerik özetiyle (sha256) kaydedilir:
- proje kapsamı: `.anafor/extensions.json`
- kullanıcı kapsamı: `~/.anafor/extensions.json`

Dosyalar sonradan değişirse eklenti yeniden taranmadan çalışmaz. MCP sunucularında `.mcp.json`'daki komut kayıttakinden farklıysa sunucu yine engellenir.

**Zorlama** PreToolUse hook'uyla yapılır ve yönetici modundan bağımsızdır. Ayar: `extensions.enforce`; değerleri `block` (varsayılan), `warn` ve `off`.
- Kayıtsız ya da değişmiş bir yerel skill'i (`.claude/skills`, `~/.claude/skills`) çağıran `Skill` aracı engellenir.
- Proje `.mcp.json`'ındaki kayıtsız bir sunucunun araçları engellenir.
- Skill dizinlerine veya `.mcp.json`'a doğrudan yazma engellenir. `claude mcp add`, `claude plugin install`, `codex mcp add`, `npx skills add` gibi komutlar da engellenir ve kullanıcı `anafor ext`'e yönlendirilir.
- `--accept-risk` onayını ajan veremez. Bulgular kullanıcıya gösterilir; kullanıcı onaylarsa komutu kendi terminalinde çalıştırır.
- SessionStart'ta engelli eklentiler listelenir. `anafor doctor`, SkillSpector'ın kurulu olup olmadığını gösterir.

**Kurulum** (Python 3.12 veya 3.13):

```bash
py -3.13 -m venv ~/.anafor/tools/skillspector            # Linux/macOS: python3.13 -m venv …
~/.anafor/tools/skillspector/Scripts/python -m pip install git+https://github.com/NVIDIA/skillspector.git
```

Farklı bir konumdaki kurulumu kullanmak için `extensions.skillspector_bin` ayarlanır.

**Sınırlar:**
- SkillSpector bir sandbox değildir. Temiz sonuç, eklentinin güvenli olduğunu kanıtlamaz; bir savunma katmanıdır.
- Anafor dışında elle kurulan eklentileri yalnızca tespit eder.
- Plugin'lerle gelen skill/MCP'ler ve claude.ai bağlayıcıları bu kapsamın dışındadır.

## 8. Eski software-orchestrator'dan göç

```bash
node /yol/anafor-mcp/dist/cli/main.js migrate /projen
```

`.orchestrator/` **salt okunur** kopyalanır: politika (yeni proje kimliğine bağlanır), görev tarihçesi, audit, checkpoint'ler ve metrikler. İşçi oturumları taşınmaz. Tekrar çalıştırılırsa reddeder.

## 8b. İşçiler ve kullanım koşulları

| İşçi | Nasıl | Durum | Koşul notu |
|---|---|---|---|
| `codex` | `codex exec` (kendi ChatGPT girişin veya API anahtarı) | ✅ doğrulandı | Resmi CLI; ayrıntılar aşağıda |
| `cirak` | `claude -p --model haiku` | ✅ doğrulandı | Resmi `claude` ikilisi; ayrıntılar aşağıda. `ANTHROPIC_API_KEY` işçi ortamından çıkarılır |
| `local` | OpenAI uyumlu API (Ollama, LM Studio) | ✅ sahte sunucuyla test | Yalnızca `analysis`/`review` (dosya düzenlemez) |
| `opencode` | `opencode run --format json` | ✅ doğrulandı (gerçek opencode 1.19.5 + OpenAI uyumlu sağlayıcı) | API anahtarı, yerel model veya ChatGPT planı. **Claude aboneliği OpenCode ile kullanılamaz**; `anthropic/*` modelleri yalnızca `allow_anthropic_api` ile |
| `gemini` | `gemini -p --output-format stream-json --approval-mode auto_edit\|plan` | ✅ doğrulandı (gerçek gemini-cli 0.68 + Gemini API uyumlu sahte sunucu) | Google AI Pro/Ultra girişi 2026-06-18'de kapandı; yalnızca API anahtarı, Vertex veya Code Assist Standard/Enterprise |
| `antigravity` | `agy -p --output-format stream-json --json-schema <dosya> --mode accept-edits\|plan` | ✅ doğrulandı (gerçek agy 1.5.9 + gerçek hesap, uyum testi), **varsayılan kapalı** | Google koşulları AI Pro/Ultra tüketici erişimini üçüncü taraf ajan/uygulamada sarmayı desteklemiyor; ihlal sayabilir ve hesap askıya alınabilir. İsteğe bağlı kullanım açık onay ve kullanıcı sorumluluğundadır |

**Kullanım sınırı:** Anafor kişisel ve yerel kullanım içindir: kendi hesabın ve makinen, resmi ve değiştirilmemiş CLI'lar. Kimlik bilgisi/oturum token'ı okunmaz, saklanmaz veya aktarılmaz; limit atlatılmaz. Anafor'u abonelik üzerinden başkalarına barındırılmış hizmet olarak sunma. Yüksek paralellik sağlayıcı kısıtlamasına yol açabilir.

- **Claude:** Anthropic [Legal & Compliance](https://code.claude.com/docs/en/legal-and-compliance) sayfasına göre kendi abonelik girişi resmi `claude` ikilisiyle ordinary, individual usage için izinlidir. Kimlik bilgisi aracılığı ve başkaları adına yönlendirme yasaktır.
- **Codex:** resmi CLI ve kendi ChatGPT girişi. [OpenAI Kullanım Politikaları](https://openai.com/policies/usage-policies/) (2026-11-20): OpenAI çıktıları rakip model eğitimi için veri/puan/sıralama üretmekte kullanılamaz. Anafor işçi istatistikleri ve ölçümleri yalnızca değerlendirme/kıyaslama içindir; eğitim verisi olarak dışa aktarılmamalıdır. Başkalarına model erişimi sağlayan platformlar OpenAI onayı ister.
- **Antigravity:** Google [FAQ](https://antigravity.google/docs/faq) ve [Ek Koşullar §6](https://antigravity.google/terms), tüketici AI Pro/Ultra erişimini üçüncü taraf ajan/uygulamada sarmayı desteklemiyor ve ihlal sayabilir; hesap askıya alınabilir. Kullanım yalnızca açık onay ve kullanıcının kendi sorumluluğunda isteğe bağlıdır. Google Gemini Enterprise veya [AI Studio API anahtarı](https://developers.googlebloggers.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli) önerir.
- Bu bilgi hukuki görüş değildir.
- Bu özet hukuki görüş değildir; güncel sağlayıcı koşullarını kendin kontrol et.

Örnek yapılandırma:

```json
{
  "workers": {
    "local": { "model": "qwen3-coder", "base_url": "http://127.0.0.1:11434/v1" },
    "opencode": { "model": "ollama/qwen3-coder" },
    "antigravity": { "enabled": false }
  },
  "routing": { "review": ["codex", "local", "cirak"] }
}
```


**Antigravity ve terminal komutları:** headless `agy`, izin soramadığı için komutları otomatik reddeder. Anafor izin atlatma bayrağı kullanmaz; bunun yerine o oturuma özel `--settings` ile yalnızca şu komutlara izin verir: projenin `test_command` değeri ve `workers.antigravity.allowed_commands`. agy 1.5.9 joker desteklemez, komutlar **birebir** eşleşmelidir. İzin listesi iş emrine de yazılır. Reddedilen komutlar iş olaylarında `error` olarak görünür.

```json
{ "test_command": "npm test", "workers": { "antigravity": { "enabled": false, "allowed_commands": ["npm run lint"] } } }
```
Antigravity isteğe bağlı tüketici aboneliği kullanımı için `anafor setup` onayını verin veya yalnızca commit edilmeyen `.anafor/config.json` içine `{ "workers": { "antigravity": { "enabled": true, "accept_terms_risk": true } } }` yazın. Bu seçenek kullanıcının kendi takdiri ve sorumluluğundadır. Anafor ve geliştiricileri, Google hesabının kısıtlanması veya kapatılması dahil hiçbir sonuçtan sorumlu değildir. Bu bilgi hukuki görüş değildir.

Gerçek uyum testleri (Antigravity: `agy` ile bir kez giriş yaptıktan sonra `ANAFOR_AGY_BIN=<agy.exe yolu> ANAFOR_E2E_AGY=1`):
- OpenCode, hesap gerektirmeden sahte sağlayıcıyla: `ANAFOR_E2E_OPENCODE_BIN=<opencode yolu> npx vitest run test/integration/opencode-real.test.ts`
- Gemini, hesap gerektirmeden sahte API ile: `ANAFOR_E2E_GEMINI_BIN=<gemini yolu> npx vitest run test/integration/gemini-real.test.ts`
- Gerçek modellerle: `ANAFOR_E2E_OPENCODE_MODEL=ollama/qwen3-coder`, `ANAFOR_E2E_GEMINI=1`, `ANAFOR_E2E_AGY=1` ile `npx vitest run test/integration/conformance.test.ts`

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
| Codex işi `partial`, testler `spawn EPERM` (Windows) | Codex sandbox'ı test çalıştırıcısının alt süreç açmasını engelliyor. `evidence_generate` → diff'i incele → `task_accept` + `verified_by_evidence_reason` |
| Gemini: `Invalid auth method selected` | `~/.gemini/settings.json` içinde `security.auth.selectedType` seçili olmalı (`anafor doctor` gösterir) |
| Hook her şeyi engelliyor | `anafor.config.json` → `director_mode: "warn"` (geçici) |

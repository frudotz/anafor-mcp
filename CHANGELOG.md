# Değişiklik Günlüğü

Biçim: [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) · Sürümleme: [SemVer](https://semver.org/lang/tr/) (0.x döneminde küçük sürüm kırıcı olabilir).

## [Yayımlanmamış]

### Eklenenler
- **Terminal arayüzü (F28):**
  - `anafor setup` ve `anafor doctor` yeniden tasarlandı: bölümler, kutular, spinner, evet/hayır soruları ([@clack/prompts](https://github.com/bombshell-dev/clack) 1.8.1, MIT, kurulum betiği yok; renkler Node `util.styleText`).
  - `doctor` sonucu `~/.anafor/health.json` dosyasına yazılır.
- **Statusline:**
  - Anafor sürümü ve yeni sürüm uyarısı (`anafor update`). Denetim 6 saatte bir arka planda yapılır; `ANAFOR_NO_UPDATE_CHECK=1` ile kapatılır.
  - Kararlılık önerileri: eski plugin → `anafor setup`; doctor sorunu veya art arda başarısız işler → `anafor doctor`.
- **`anafor update [--check]`:** son sürümü indirir, SHA256SUMS ile doğrular, kurar ve plugin'i yeniler.

- **Yapay zekâ kurulum rehberi (F25):**
  - `docs/agent-install.md` (İngilizce): temel kurallar, adım adım kurulum, tanılama kodu → eylem tablosu, yaygın kurulum hataları.
  - `llms.txt`, README'de yapay zekâ ajanları için yönlendirme.
  - `anafor doctor --json`: kararlı kodlar (`CODEX_SANDBOX_UNELEVATED`, `PLUGIN_OUTDATED`, `EXTENSIONS_BLOCKED`, …) ve düzeltme komutları. Bir test, rehberin tüm kodları kapsadığını denetler.

### Değişenler
- `anafor setup` proje bağlama sorusunda varsayılan cevap artık "hayır". `--no-project` eklendi.

## [0.4.0] - 2026-11-17

### Eklenenler
- **Kapasite modeli ve ipuçları (F20):**
  - `anafor capacity` ve MCP `capacity_status`: hesap başına boş KP (rezerv sonrası), tempo ve dolma süresi.
  - İş başına maliyet, pencerenin işten önceki ve sonraki farkından öğrenilir (EMA + p80).
  - Rol başına kalan iş tahmini ve yönlendirme ipuçları.
  - Rol dağılımı önerisi: `anafor capacity recommend <abonelikler> [--apply]`, meta 2026-Q4 profilinden (#38).
- **Yük dengeleyici (F21):** router, rol zincirini abonelik kapasitesine göre yeniden sıralar. Stratejiler: `balanced`, `protect-brain`, `cheap-first`, `off`. Kararın gerekçesi `job_dispatch` uyarısında ve `route` olayında görünür (#39).
- **Token optimizasyonu (F22):**
  - Önbellek dostu iş emri: sabit önek önde, işe özgü kısım sonda.
  - Devam oturumunda kısa düzeltme emri.
  - `summary` 2000 karakterle sınırlı.
  - `token_profile` ile rol başına effort: Codex `model_reasoning_effort`, claude-lite `--effort`. `workers.<id>.effort` ile işçi bazında ezilebilir.
  - Codex işlerinde `analytics.enabled=false` (#40, #41).
- **SkillSpector eklenti kapısı (F23):**
  - `anafor ext add | add-mcp | adopt | check | list | remove`.
  - HIGH/CRITICAL ve tarama hatası engellenir. CAUTION yalnızca kullanıcının `--accept-risk` onayıyla geçer.
  - Kayıt içerik özetiyle tutulur. PreToolUse hook'u kayıtsız ya da değişmiş skill ve MCP çağrılarını, doğrudan yazmayı ve resmi kurulum komutlarını engeller (`extensions.enforce`).
  - SessionStart ve `anafor doctor` durumu gösterir (#42).

### Değişenler (güncellerken dikkat)
- **Hook matcher'a `Skill|mcp__.*` eklendi.** `anafor setup` ile plugin yenilenince, Anafor projelerinde taranmamış yerel skill'ler (`.claude/skills`, `~/.claude/skills`) ve proje `.mcp.json` sunucuları engellenir. Önce `anafor ext check`, ardından `anafor ext adopt <ad> [--user]` çalıştırın. Geçici olarak kapatmak için: `extensions.enforce: "warn"`.
- **Router artık varsayılan olarak `balancer.strategy: "balanced"`.** İstemiyorsanız `"off"` yapın.
- **İşlere artık varsayılan olarak `token_profile: "balanced"` effort'u geçirilir:** review high, test low. İşçinin kendi varsayılanı için `"off"` yapın.
- **İş emrinin bölüm sırası değişti.** Kimlik bilgisi artık sonda, `## Kimlik` bölümünde.

## [0.3.0] - 2026-11-17

### Eklenenler
- **Lat.md otomatik bağlam:** projede `lat.md/` varsa yeni işlerin emrine `lat search` ile seçilen ilgili bölümler eklenir (lat yoksa yerleşik arama); `memory_context` (#33).
- **Worktree bağımlılık önbelleği:** `worktree_cache`, kilit dosyası aynıysa `node_modules`'ü hardlink ile çoğaltır, `worktree_setup` atlanır (Anafor'da 5003 dosya 3,5 sn; `npm ci` ~9,4 sn) (#34).
- **Makine geneli eşzamanlılık sınırı:** `max_parallel_jobs` (varsayılan 4), runner kiraları `~/.anafor/running/`, `project_status.parallel` (#31).
- **Antigravity terminal komutları:** headless agy için oturumluk birebir komut izinleri (`test_command`, `workers.antigravity.allowed_commands`), reddedilen komut ve çıkış kodu olayları (#32).

### Düzeltilenler
- **Codex Windows `spawn EPERM` kök çözümü:** unelevated sandbox isimli pipe'a izin vermediği için işçi test çalıştıramıyordu. `workers.codex.windows_sandbox: "elevated"` ayarı ve `anafor doctor` teşhisi eklendi; gerçek Codex işiyle doğrulandı (#30).
- Windows'ta npm ile kurulan CLI'lar (uzantısız betik `.cmd`'den önce listelendiği için) kabuksuz başlatılıp ENOENT veriyordu (#33).
- agy `read_file` aracı dosya değişikliği sayılıyordu (#32).

### Değişenler
- `anafor migrate` raporu, `.orchestrator/` içinde yerinde kalan (taşınmayan) eski artefaktları ve eski kilidi listeler (#35).

## [0.2.0] - 2026-11-17

### Eklenenler
- **Yeni işçiler:** `opencode` (API anahtarı, yerel model veya ChatGPT planı), `gemini` (yalnızca API anahtarıyla), `antigravity` (varsayılan kapalı, açık onayla), `local` (OpenAI uyumlu API: Ollama, LM Studio). Hepsi gerçek araçlarla doğrulandı (#14, #23–#27).
- **Terminal CLI:** `anafor chat` (beyin ajanla sohbet, izin sorma, canlı iş takibi), `anafor run "<hedef>"` (headless), `anafor jobs`, `anafor watch`, `anafor roles`, `anafor limits` (#15, #18).
- **Kolay kurulum:** `anafor setup` sihirbazı; kalıcı plugin (`claude plugin install`) ve statusline (#16, #28). Derlenmiş release paketiyle kurulum.
- **Görev devralma:** işçiler tekrar tekrar başarısız olursa yönetici `task_takeover` ile devralır (#12).
- **Limitler:** Codex ve Claude oturum/kullanım pencereleri; limiti dolu işçi atlanır (#13).
- **Otomatik kanıt:** `evidence_generate` (test + gizli bilgi taraması; gitleaks varsa onu da kullanır) (#17, #22).
- **Kanıtla doğrulanmış kabul:** işçi testleri çalıştıramadığında Anafor'un kendi kanıtıyla kabul (#19).
- **İşçi istatistikleri ve uyarlanabilir yönlendirme:** `worker_stats`, `routing_mode: adaptive` (#20; Anafor ile dogfooding yapılarak üretildi).
- `project_status.recently_closed` (#17).

### Düzeltilenler
- **Güvenlik:** varsayılan izinli yollardaki `.anafor/**` yöneticinin işçi worktree'lerini hook'a takılmadan düzenlemesine izin veriyordu (#12).
- **İzolasyon:** bazı işçiler (bun tabanlı opencode) cwd yerine miras `PWD`'yi kullanıp worktree dışına yazıyordu; tüm işçilerde `PWD = cwd` (#24).
- Ev dizinindeki `~/.anafor` proje sanılıyordu; `anafor doctor` istemeden `.anafor/` oluşturuyordu (#15, #16).
- Gemini: parçalı (`delta`) yanıtların birleştirilmemesi, onay modu, kimlik ayarı, Windows çıkış çökmesi (#25).
- `claude-lite` işçisinde `ANTHROPIC_API_KEY` ayıklanır (abonelik yerine API faturalanmasın) (#12).
- `npm install -g github:…` çalışmıyordu; derlenmiş release paketiyle kurulum (#28).

## [0.1.0] - 2026-11-17

### Eklenenler
- MCP sunucusu ve Claude Code plugin'i: görev ve iş yaşam döngüsü, ayrık runner, SQLite durum (#2–#4).
- Codex ve `claude-lite` işçileri; adaptör arayüzü ve ortak uyum testi (#3, #9).
- Yönetici disiplini: PreToolUse hook, `intervene` istisnası (#6).
- Kabul kapıları, `job_diff`, `task_close` (#7).
- Git worktree paralelliği, `task_merge`, `workspace_cleanup` (#8).
- Yönetişim: checkpoint, işlem yetki kapısı, append-only audit, hafıza kilidi, eski `software-orchestrator`'dan göç (#10, #11).

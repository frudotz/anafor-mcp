# Değişiklik Günlüğü

Biçim: [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) · Sürümleme: [SemVer](https://semver.org/lang/tr/) (0.x döneminde küçük sürüm kırıcı olabilir).

## [Yayımlanmamış]

- Yönetici kancası paket yöneticisi değişikliklerini tutarlı engeller; doğrulanmış güncellemeler kurulum betiklerini devre dışı bırakır, sürüm paketi üretim bağımlılıklarını içerir.

## [0.10.0] - 2026-11-20

### Eklenenler
- Yarım kalan implementation işini aynı oturumla otomatik devam ettirme; `auto_continue.max` ile ayarlanır (#98).
- `job_dispatch`, aynı dosyalara dokunan başka bir açık görev varsa çakışma uyarısı verir (#100).
- `job_result` yanıtında `tests_verification`: işçinin test iddiası auto_check ile karşılaştırılır (#99).

### Değişenler
- Yönetici modu, proje dışındaki `cd <dizin> && ...` komutlarını engellemez (#97).
- Kabul edilen ya da kapatılan görevlerin bekleyen işleri otomatik kapanır; bayat düşük bulgular ayrı listelenir (#99).
- Kanıt yollarındaki `:satır`, `#Lx` ve açıklama ekleri ayıklanır (#100).

### Düzeltilenler
- Review/analysis işlerinde yanlış `job_diff` uyuşmazlık uyarısı kaldırıldı (#99).
- PR atfı yedeği `.gitignore`'a eklenir (#96).

### Geçiş notu
- Otomatik devam varsayılan olarak açıktır (en fazla 1 kez); kapatmak için `auto_continue.enabled: false` ayarlayın.

## [0.9.0] - 2026-11-20

### Eklenenler
- İşçi eşzamanlılığı doluyken işleri kalıcı kuyruğa alma (#89).
- Rol failover desteği (#90).
- Döngü kurtarma `anafor loop recover` ve isteğe bağlı bekçi `anafor loop watchdog` komutları (#92).
- Döngü bitince isteğe bağlı kapatma için `--shutdown-on-finish` (#93).
- PR atıfı için `anafor attribution` komutu (#94).

### Değişenler
- Limit uyarısı döngüde “büyük iş başlatma”, döngü dışında “uyar ve onay iste” der (#89).
- İşçi güvenlik kuralları ve failover metinleri i18n kapsamına alındı (#91).

### Düzeltilenler
- Windows'ta alt süreç konsol pencereleri gizlendi (#87).
- Test geçici dizin temizliğinde Windows kilit toleransı artırıldı (#88).

### Geçiş notu
- `dispatch`, eşzamanlılık doluyken hata vermek yerine `queued` döndürür.
- Failover varsayılan olarak açıktır; kapatmak için `failover.enabled: false` ayarlayın.
- Döngü kurtarma varsayılan olarak açıktır; kapatmak için `loop.recover_on_crash: false` ayarlayın.

## [0.8.0] - 2026-11-19

### Eklenenler
- **Yalın headless beyin:** `anafor run/loop` varsayılan olarak yalın çalışır; araç profili ile `brain.model`/`brain.effort` yapılandırması eklendi (#74).
- **İş sonrası otomatik doğrulama:** `auto_check` ve `job_result` diff özeti eklendi (#75).
- **İşçi ortamı ve inceleme:** işçi ortam yoklaması ve çalışma ortamı notu, kanıtı yeniden kullanma ve odaklı inceleme emri eklendi (#77, #78).
- **İzin analizi:** `anafor permissions` reddedilen izinleri ölçer ve dar kapsamlı allow önerileri sunar (#84).
- **Model uzmanlık sıralaması:** yönlendirme için model uzmanlık ipuçları eklendi (#82).

### Değişenler
- Standard görevler kabulden önce bağımsız inceleme gerektirir; inceleyici `review.worker`/`review.model` ile ayarlanır (#79).
- İnceleme bulguları varken kabul engellenir (#80).
- İş emri tamamlama, rapor dili ve inceleyici karar kuralları netleştirildi (#81).
- İşçi güvenlik ve sandbox kuralları güncellendi (#78, #85).
- README yenilendi (#76).

### Düzeltilenler
- Ortam yoklamasında stdin/JSON, başarısız sonuçlu işlerde devralma ve kabul commit'inde `.anafor-tmp` dışlama düzeltildi (#78).
- İşçi sandbox'ındaki kararsız test düzeltildi (#83).

### Geçiş notu
- Standard görevler artık kabulden önce inceleme ister; eski davranış için `review.require_for: 'none'` ayarlayın.
- `anafor run/loop` beyni varsayılan olarak yalındır; eski davranış için `brain.lean: false` ayarlayın.

## [0.7.0] - 2026-11-19

### Eklenenler
- **Limit uyumlu geliştirme döngüsü:** `anafor loop`; %75 uyarı, %90 duraklama, haftalık %95 sınırı, güvenli nokta, isteğe bağlı `--auto-resume`, aynı oturumda devam, backlog/hedef ve kilit (#69).
- **Döngü araçları ve arayüzü:** MCP araçları `loop_start`/`loop_status`/`loop_stop`, `/anafor:loop`, UserPromptSubmit limit uyarısı, SessionStart döngü özeti ve durum satırında döngü göstergesi (#70).
- **Marka kimliği:** `assets/brand` SVG varyantları, renk token'ları, kılavuz, build/verify/raster betikleri ve README logosu (#71).
- **`anafor init --exclude-local`:** `.anafor/` girdisini `.gitignore` yerine ortak `.git/info/exclude` dosyasına yazar (#72).

### Değişenler
- Antigravity yalnızca açık onayla isteğe bağlıdır (`enabled` + `accept_terms_risk`, yalnızca yerel config); uyarı ve sorumluluk reddi eklendi (#67).
- MCP sunucusu config değişince yeniden yükler (#68).

### Düzeltilenler
- Deep inceleme kapısı, salt okunur inceleyicinin “test çalıştırılamadı” kısmi sonucunu kabul eder; TOML satır içi tablo kenar durumları düzeltildi (#68).
- `evidence_generate` birleştirilmemiş iş worktree'sinde çalışır; kabul kapısı `yol:N-M` kanıt konumlarını çözer (#72).
- İşçi sandbox'ında geçici dizin temizliği `EPERM` hatası düzeltildi (#66).

### Geçiş notu
- Antigravity kullananlar yerel `.anafor/config.json` dosyasında `enabled` ve `accept_terms_risk` vermelidir.

## [0.6.0] - 2026-11-19

### Eklenenler
- **Olay tabanlı bekleme (F30):** `anafor job wait <id…> [--mode any|all] [--timeout] [--silence]`; uzun işler yoklamasız bekler, sessizlik uyarısı işi iptal etmez (ADR-0020, #55).
- **İşçi yalıtımı (F31):** Codex varsayılan olarak kullanıcı yapılandırmasını yok sayar; uygulama bağlayıcıları, web araması ve görsel üretim kapalıdır. Yalnızca model, effort ve Windows sandbox ayarları taşınır; hafif işçi slash komutları kapatır. `workers.<id>.user_config: "inherit"` yalnızca yerel yapılandırmadan kabul edilir. İlk tur girdi token tasarrufu yaklaşık %22 (#59).
- **Resmi Codex limitleri:** `codex app-server` üzerinden `account/rateLimits/read`; rollout yedek okumadır, `anafor limits --refresh` eklendi (#61).
- **Durum satırında işçi limitleri:** Codex 5 saatlik ve haftalık limitler; eski veri soluk, 24 saatten eski veri gizli. `statusline.workers` ile ayarlanır (#62).
- **Belgeler:** kullanım sınırı ve sağlayıcı koşulları bölümü (#60).

### Değişenler
- `claude-lite` işçisinin adı `cirak` oldu; eski ad takma ad olarak çalışır ve bir kez uyarır (#63).
- Tanıtım metinleri model eşlemesi yerine “frontier modeller için orkestrasyon MCP sunucusu” der (#64).
- MCP sunucusu, hook'lar ve CLI proje kökünü aynı sırayla bulur: `ANAFOR_PROJECT_ROOT` → `CLAUDE_PROJECT_DIR` → cwd (#55).

### Düzeltilenler
- Yönetici hook'u tırnak içindeki ve heredoc gövdesindeki `>` işaretini yönlendirme saymaz (#56).
- mcp-e2e testinin Windows temizlik kararsızlığı giderildi (#58).

### Geçiş notu
- Config dosyalarında `claude-lite` varsa `anafor migrate` çalıştırın. Takma ad sayesinde çalıştırılmasa da bozulmaz.

## [0.5.0] - 2026-11-18

### Eklenenler
- **Terminal arayüzü (F28):**
  - `anafor setup` ve `anafor doctor` yeniden tasarlandı: bölümler, kutular, spinner ve evet/hayır soruları. Kullanılan kütüphane: [@clack/prompts](https://github.com/bombshell-dev/clack) 1.8.1 (MIT, kurulum betiği yok).
  - Statusline'da Anafor sürümü, yeni sürüm uyarısı (`⬆ … anafor update`) ve kararlılık önerileri (`⚠ … anafor doctor/setup`) gösterilir.
  - `anafor update [--check]`: son sürümü indirir, SHA256SUMS ile doğrular, kurar ve plugin'i yeniler (#44).
- **Yapay zekâ kurulum rehberi (F25):**
  - `docs/agent-install.md` (İngilizce) ve `llms.txt`.
  - `anafor doctor --json`: kararlı tanılama kodları ve düzeltme komutları (#45).
- **İngilizce dil desteği (F24):**
  - `anafor setup` ilk adımda Türkçe/English sorar; `--lang` ve `ANAFOR_LANG` desteklenir.
  - Çevrilen alanlar: CLI, hook'lar, işçi uyarıları, kapasite ve eklenti mesajları, MCP sunucusu ve araç açıklamaları, işçiye giden iş emri.
  - İngilizce README ile kurulum ve kullanım dokümanları eklendi (#46, #47, #48, #52, #53).
- **Kurulumda abonelik seçimi (F26):** `anafor setup` yapay zekâ aboneliklerini sorar (`--subscriptions`), meta profiline göre rol dağılımını önerir ve projeye uygular (#50).
- **Katkı koruması (F29):**
  - PR diff'ini veri olarak inceleyen kurallar (G01–G19). İş akışı `pull_request_target` ile tetiklenir ve taban daldaki betiği çalıştırır; `guard` artık zorunlu kontrol.
  - `docs/sharing-fixes.md` (doctor ile bulunan düzeltmeleri paylaşma) ve `SECURITY.md` eklendi (#49).
- **Yönetişim:**
  - İki bakımcılı onay ruleset'i (frudotz, RedRiveRR) ve `NOTICE` (AGPL-3.0 §7(b) atıf şartı).
  - `anafor version` çıktısına kaynak ve lisans satırı eklendi.
  - Issue şablonları iki dilli oldu (#51).

### Değişenler
- `anafor setup` proje bağlama sorusunda varsayılan cevap artık "hayır"; `--no-project` eklendi.
- Kurulum adımları: 0 dil · 1 ortam · 2 işçiler · 3 abonelikler · 4 plugin · 5 statusline · 6 proje.
- `anafor version` iki satır yazar (sürüm + kaynak/lisans); yalnızca sürüm için `anafor --version`.

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

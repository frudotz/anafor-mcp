# Değişiklik Günlüğü

Biçim: [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) · Sürümleme: [SemVer](https://semver.org/lang/tr/) (0.x döneminde küçük sürüm kırıcı olabilir).

## [Yayımlanmamış]

### Eklenenler
- **Kapasite modeli ve ipuçları (F20):**
  - `anafor capacity` ve MCP `capacity_status` aracı.
  - Hesap başına boş KP (rezerv sonrası), tempo ve dolma süresi.
  - İş başına maliyet, işten önceki ve sonraki pencere farkından öğrenilir (EMA + p80).
  - Rol başına kalan iş tahmini ve yönlendirme ipuçları.
- **Yük dengeleyici (F21):** router, rol zincirini abonelik kapasitesine göre yeniden sıralar. Stratejiler: `balanced` (varsayılan), `protect-brain`, `cheap-first`, `off`. Rezerve ulaşmış veya maliyeti sığmayan hesaplar sona, hızlı tükenenler ortaya alınır. Kararın gerekçesi `job_dispatch` uyarısında ve `route` olayında görünür.
- **Token optimizasyonu (F22):**
  - Önbellek dostu iş emri: sabit önek önde, işe özgü kısım sonda.
  - Devam oturumunda kısa düzeltme emri.
  - `summary` 2000 karakterle sınırlı.
  - Token profili (`saver`, `balanced`, `quality`, `off`) ile rol başına effort; Codex `model_reasoning_effort`, claude-lite `--effort`.
  - `workers.<id>.effort` ile işçi bazında ezme.
  - Codex işlerinde `analytics.enabled=false`.
- **Rol dağılımı önerisi:** `anafor capacity recommend <abonelikler> [--apply]` dönemsel meta profilinden (2026-Q4) çalışır. Öneri beynin hesabını korur ve incelemeyi farklı bir model ailesine verir.

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

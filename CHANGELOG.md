# Değişiklik Günlüğü

Biçim: [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) · Sürümleme: [SemVer](https://semver.org/lang/tr/) (0.x döneminde küçük sürüm kırıcı olabilir).

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

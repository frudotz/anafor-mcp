const GUIDE =
  'Harici skill/MCP yalnızca SkillSpector kapısından kurulur: `anafor ext add <kaynak>` (skill) veya `anafor ext add-mcp <ad> --source <kaynak> -- <komut…>`; mevcut olanı taratmak için `anafor ext adopt <ad>`.';

/** Türkçe mesaj kataloğu (kaynak dil). Anahtarlar `en.ts` ile birebir aynı olmalı. */
export const tr = {
  help: (v: string) => `anafor ${v}
kullanım:
  anafor setup [--yes] [--lang tr|en] [--no-plugin] [--no-statusline] [--no-project]
                          ilk kurulum sihirbazı (dil, işçiler, kalıcı plugin, statusline, proje)
  anafor init [dizin]     projeyi bağlar: .anafor/, politika (.mcp.json plugin yoksa)
  anafor doctor [dizin] [--json]
                          ortam, proje ve işçi kontrolü (--json: yapay zekâ ajanları için)
  anafor update [--check] son sürümü indirir, SHA256 doğrular, kurar ve plugin'i yeniler
  anafor mcp [dizin]      MCP sunucusunu stdio üzerinde başlatır
  anafor migrate [dizin]  eski .orchestrator/ durumunu .anafor/'a kopyalar (kaynak değişmez)
  anafor chat [--new] [--once "mesaj"] [--model m]
                          beyin ajanla terminalden konuşma; işler canlı izlenir
  anafor run "<hedef>" [--accept] [--merge] [--worker w] [--review seviye]
                          headless: beyin hedefi kullanıcısız yürütür (izin istekleri reddedilir)
  anafor jobs [--all]     görev ve iş panosu
  anafor watch            canlı iş olayları
  anafor roles [set <rol> <işçi1,işçi2>]
                          beyin ve işçi rolleri
  anafor limits           bağlı yapay zekâların oturum/kullanım limitleri
  anafor capacity [--json] kapasite (KP), rol başına kalan iş tahmini ve yük ipuçları
  anafor capacity recommend <abonelik1,abonelik2> [--apply]
                          aboneliklere göre önerilen rol dağılımı (meta profili)
  anafor ext <check|list|add|add-mcp|adopt|remove>
                          harici skill/MCP için SkillSpector kapısı
  anafor statusline       Claude Code statusLine komutu
  anafor hook <olay>      Claude Code hook'u (pre-tool-use | session-start), girdi stdin'den
  anafor version
Dil: ANAFOR_LANG=tr|en veya anafor setup --lang`,

  ui: { yes: 'Evet', no: 'Hayır', cancelled: 'İptal edildi.' },

  setup: {
    title: (v: string) => ` Anafor kurulumu · v${v} `,
    language: 'Dil / Language',
    envCheck: 'Ortam denetleniyor',
    envTitle: '1 · Ortam',
    nodeNeed: '(24+ gerekli)',
    notFound: 'bulunamadı',
    envMissing: 'Gerekli bileşenler eksik; kurup `anafor setup` komutunu yeniden çalıştırın.',
    workersDetect: 'İşçiler algılanıyor',
    workersTitle: (ready: number, total: number) =>
      `2 · İşçiler (${ready}/${total} hazır · beyin: Claude Code)`,
    unavailable: 'kullanılamıyor',
    pluginStep: '3 · Claude Code plugin’i',
    pluginStepHint: 'yönetici hook’ları, Anafor MCP, /anafor:* komutları',
    pluginAsk: 'Plugin Claude Code’a kalıcı kurulsun mu?',
    pluginOk: 'Kuruldu: anafor@anafor-local',
    pluginFail: 'Kurulamadı',
    pluginSession: 'Kalıcı kurulmadı; oturumluk:',
    statusStep: '4 · Statusline',
    statusStepHint: 'sürüm, güncelleme, limitler ve sağlık durumu',
    statusAsk: 'Statusline kurulsun mu? (mevcut ayar korunur)',
    projectStep: '5 · Proje',
    projectAlready: 'Bu dizin zaten Anafor projesi:',
    projectAsk: 'Bu git deposu Anafor’a bağlansın mı?',
    projectDone: 'Proje bağlandı.',
    projectHint: 'Bir projede bağlamak için:',
    nextTitle: 'Sonraki adımlar',
    nextClaude: 'Claude Code içinde: /anafor:plan <hedef>',
    nextChat: 'beyin ajanla terminalden konuş',
    nextCapacity: 'limitler, kalan iş ve rol önerisi',
    nextDoctor: 'sorun olursa kontrol',
    guide: 'Kılavuz:',
    ready: 'Hazır.',
    restart: 'Değişikliklerin geçerli olması için Claude Code’u yeniden başlatın.',
  },

  doctor: {
    title: (v: string) => ` anafor doctor · v${v} `,
    sections: { Anafor: 'Anafor', Ortam: 'Ortam', Proje: 'Proje', İşçiler: 'İşçiler' },
    workersReady: (ready: number, total: number) => `İşçiler (${ready}/${total} hazır)`,
    workersCheck: 'İşçiler denetleniyor',
    version: 'sürüm',
    updateAvail: (cur: string, next: string) => `v${cur} → v${next} mevcut`,
    setup: 'kurulum',
    setupMissing: 'kurulum sihirbazı çalıştırılmamış',
    plugin: 'plugin',
    pluginPersistent: (v: string) => `kalıcı kurulu (v${v})`,
    pluginNotPersistent: 'kalıcı kurulu değil',
    nodeFix: 'Node 24+ kurun: https://nodejs.org',
    notFound: 'bulunamadı',
    gitRepo: 'git deposu',
    yes: 'evet',
    notGitRepo: 'bu dizin git deposu değil',
    project: 'proje',
    notInit: 'bu dizin Anafor’a bağlı değil',
    store: 'durum deposu',
    storeFix:
      '.anafor/state.db başka bir süreç tarafından kilitli olabilir; Claude Code oturumlarını kapatıp yeniden deneyin',
    last24: 'son 24 sa',
    failedJobs: (n: number) => `${n} başarısız iş`,
    jobsFix: 'anafor jobs --all (hata nedenleri)',
    extensions: 'eklentiler',
    extBlocked: (n: number, list: string) => `${n} engelli: ${list}`,
    extOk: 'tümü taranmış',
    ssMissing: 'yok: harici skill/MCP eklenemez',
    ssFix:
      'Python 3.13 venv + pip install git+https://github.com/NVIDIA/skillspector.git (docs/kullanim.md §7e)',
    unavailable: 'kullanılamıyor',
    worker: 'işçi',
    noWorkers: 'hiç kullanılabilir işçi yok',
    problems: (n: number, list: string) => `${n} sorun: ${list}`,
    warnings: (n: number, list: string) => `Çalışır durumda; ${n} öneri: ${list}`,
    allGood: 'Her şey yolunda.',
  },

  status: {
    update: (v: string) => `⬆ v${v}: anafor update`,
    pluginOld: (v: string) => `plugin v${v}`,
    problem: 'sorun var',
    jobsFailed: (n: number) => `${n} iş başarısız`,
  },

  update: {
    upToDate: (v: string) => `Anafor güncel: v${v}`,
    newVersion: (cur: string, next: string) => `Yeni sürüm: v${cur} → v${next}`,
    verified: (h: string) => `✔ SHA256 doğrulandı (${h}…)`,
    installed: '✔ Paket kuruldu; plugin yenileniyor…',
    pluginFail: '▲ Plugin yenilenemedi; `anafor setup` komutunu elle çalıştırın.',
    done: (v: string) => `Güncellendi: v${v}. Claude Code’u yeniden başlatın.`,
    failed: (e: string) => `Güncelleme başarısız: ${e}`,
  },

  windows: {
    reset: 'sıfırlandı',
    fiveHour: '5s',
    sevenDay: '7g',
    locale: 'tr-TR',
  },

  cli: {
    notProject: 'Bu dizin bir Anafor projesi değil. Önce `anafor init` (veya `anafor setup`).',
    pluginMcp: 'Anafor plugin’i kalıcı kurulu: MCP sunucusu plugin’den gelir, .mcp.json yazılmadı.',
    mcpCreated: '.mcp.json oluşturuldu (anafor sunucusu).',
    mcpExists: '.mcp.json zaten var; anafor girdisini elle ekleyin:',
    ready: (dir: string) => `Anafor hazır: ${dir}`,
    migrateFailed: (e: string) => `göç başarısız: ${e}`,
    runUsage:
      'kullanım: anafor run "<hedef>" [--accept] [--merge] [--worker w] [--review lightweight|standard|deep] [--model m]',
    watching: 'İşler izleniyor (Ctrl+C ile çık)…',
    rolesUsage: (roles: string) => `kullanım: anafor roles set <${roles}> <işçi1,işçi2,…>`,
    unknownWorkers: (unknown: string, known: string) =>
      `uyarı: kayıtlı olmayan işçi: ${unknown} (kayıtlı: ${known})`,
    brainRow: 'beyin       claude (Claude Code + Anafor plugin)',
    balancer: (strategy: string) =>
      `\nyük dengeleyici: ${strategy} (balancer.strategy: off | balanced | protect-brain | cheap-first)`,
    workers: (list: string) => `işçiler: ${list}`,
    rolesHint: 'değiştirmek için: anafor roles set <rol> <işçi1,işçi2>',
    noLimits: 'Henüz limit bilgisi yok (işçi çalıştıkça veya statusline ile dolar).',
    ago: (min: number, source: string) => `(${min} dk önce, ${source})`,
  },

  capacityCmd: {
    fullInDays: (n: number) => ` ~${n}g'de dolar`,
    fullInHours: (n: number) => ` ~${n}sa'de dolar`,
    title: 'Kapasite (KP = pencerenin %1’i; boş = 100 − kullanım − rezerv)',
    noObservation: 'gözlem yok',
    free: 'boş',
    pace: 'tempo',
    roleRow: (kp: number, left: number, samples: number) =>
      `iş başı ~${kp} KP → ~${left} iş (${samples} ölçüm)`,
    hints: 'İpuçları:',
    noSubscriptions:
      'Abonelik seçilmemiş: önerilen rol dağılımı için `anafor capacity recommend <abonelik1,abonelik2>`',
    recTitle: (period: string) => `Önerilen rol dağılımı (meta ${period}):`,
    brain: 'beyin',
    subscriptions: 'Abonelikler:',
    tiers: 'Kademeler:',
    recUsage: 'kullanım: anafor capacity recommend <abonelik1,abonelik2> [--apply]',
    applied: 'anafor.config.json güncellendi: subscriptions + routing.',
    applyHint: 'Uygulamak için: --apply (anafor.config.json → subscriptions + routing)',
  },

  capacity: {
    days: (n: number) => `${n} gün`,
    hours: (n: number) => `${n} sa`,
    notObserved: (account: string, roles: string) =>
      `${account}: limit henüz gözlenmedi (${roles} rollerinde kullanılıyor); ilk işlerden sonra tahmin oluşur.`,
    reserveReached: (
      account: string,
      label: string,
      used: number,
      reserve: number,
      resets: string | null,
    ) =>
      `${account}: ${label} penceresi rezerve ulaştı (%${used}, rezerv %${reserve})` +
      (resets ? `; ${resets} sıfırlanır` : '') +
      '. Yeni işler sıradaki işçiye gitmeli.',
    fastDrain: (account: string, label: string, pace: number, dur: string, resets: string) =>
      `${account}: ${label} hızlı tükeniyor (tempo ×${pace}); bu hızla ~${dur} içinde dolar, sıfırlanma ${resets}.`,
    jobsLeft: (account: string, role: string, left: number, kp: number) =>
      `${account}: '${role}' için ~${left} iş kapasitesi kaldı (iş başı ~${kp} KP).`,
    promote: (role: string, first: string, next: string, cmd: string) =>
      `'${role}' rolü: ${first} kısıtlı → ${next} öne alınabilir (${cmd}).`,
    noBackup: (role: string, first: string) =>
      `'${role}' rolü: ${first} kısıtlı ve zincirde sağlıklı yedek yok; başka bir işçi eklemeyi düşünün.`,
  },

  balancer: {
    reserve: (name: string, used: number) => `${name} rezerve ulaştı (%${used})`,
    noFit: (kp: number) => `tahmini iş maliyeti (~${kp} KP) boş alana sığmıyor`,
    fast: (name: string, pace: number) => `${name} hızlı tükeniyor (tempo ×${pace})`,
    protectBrain: 'beynin hesabı korunuyor',
    cheaper: 'daha ucuz kademe',
    note: (strategy: string, before: string, after: string) =>
      `yük dengeleyici (${strategy}): ${before} yerine ${after}`,
  },

  meta: {
    tiers: {
      K1: 'öncü (Opus, Codex üst)',
      K2: 'orta-güçlü (Sonnet, Codex orta, Gemini Flash)',
      K3: 'ucuz API / açık ağırlıklı (GLM, DeepSeek, Kimi, Qwen)',
      K4: 'hafif (Haiku, Codex Luna)',
      K5: 'yerel (Ollama, LM Studio)',
    },
    labels: {
      claudeUltra: 'Claude Ultra (10x, 5 saatlik pencere yok)',
      chatgptPro: 'ChatGPT Pro (Codex, yalnızca haftalık)',
      geminiApi: 'Gemini API anahtarı',
      localGpu: 'Yerel model (24 GB+ GPU)',
    },
    notes: {
      claudeMax: 'claude-lite işçisinde Sonnet kullanılabilir (workers.claude-lite.model).',
      geminiApi: 'Kişisel hesap girişi Gemini CLI tarafından desteklenmiyor; API anahtarı gerekir.',
      antigravity: 'Koşullar gri alan; varsayılan kapalı, acknowledge_terms gerekir.',
      opencodeApi: 'Qwen Coding Plan otomasyonu yasaklar; kullandıkça öde API tercih edin.',
      localGpu:
        'Yalnızca kısa işler: dokümantasyon, test iskeleti, tek dosya. Beyin/plan/inceleme asla.',
    },
    headless: { ok: 'ok', gri: 'gri', yasak: 'yasak' },
    terms: (label: string, headless: string, note: string) =>
      `${label}: koşullar ${headless}. ${note}`,
    unknownSub: (unknown: string, known: string) =>
      `Bilinmeyen abonelik: ${unknown} (bilinenler: ${known})`,
    needClaude: 'Beyin için Claude aboneliği gerekir (Anafor yöneticisi Claude Code).',
    brainPro: 'Sonnet (Opus yalnızca plan/karar noktalarında)',
    brainMax: 'Opus (limit baskısında Sonnet + Opus danışman)',
    brainFrontier:
      'Beyin öncü kademede: token’ların çoğunu işçiler harcar, beyin hatası tüm turu boşa çıkarır.',
    crossFamily: (impl: string, reviewer: string) =>
      `İnceleme farklı model ailesinde: ${impl} uygular, ${reviewer} inceler.`,
    singleFamily: 'Tek model ailesi var: inceleme uygulayıcıyla aynı aileden (kör nokta riski).',
    localOnly: 'Yerel model yalnızca test/analiz yedeği; uzun ajan döngülerinde güvenilmez.',
    noWorker: (role: string) => `'${role}' için uygun işçi yok.`,
  },

  chat: {
    session: (id: string, model: string) => `[beyin oturumu ${id} · ${model}]`,
    brainPrompt: 'beyin ›',
    turnDone: 'tur bitti',
    steps: (n: number) => `${n} adım`,
    apiCost: (usd: string) => `API eşdeğeri ~$${usd}`,
    closed: (code: string) => `[beyin oturumu kapandı (${code})]`,
    noTasks: '(görev yok)',
    noLimits: '(limit bilgisi yok)',
    deniedHeadless: (tool: string) => `! izin reddedildi (etkileşimsiz): ${tool}`,
    askPermission: (tool: string, brief: string) =>
      `? Beyin izin istiyor: ${tool} ${brief}\n  [e]vet / [h]ayır / [d]aima (bu oturum): `,
    title: 'Anafor sohbet',
    youPrompt: 'sen › ',
    pending: (n: number) => `${n} bekleyen izin isteği`,
    newSession: 'Yeni oturum için çıkıp `anafor chat --new` çalıştırın.',
    sessionClosed: 'Beyin oturumu kapalı; `anafor chat` ile yeniden başlatın.',
  },

  ext: {
    install:
      'SkillSpector bulunamadı. Kurulum (Python 3.12/3.13): `py -3.13 -m venv ~/.anafor/tools/skillspector` ve `~/.anafor/tools/skillspector/Scripts/python -m pip install git+https://github.com/NVIDIA/skillspector.git` (Linux/macOS: bin/python), ya da `uv tool install --python 3.13 git+https://github.com/NVIDIA/skillspector.git`. Özel yol: anafor.config.json → extensions.skillspector_bin',
    scan: 'tarama',
    score: 'skor',
    installed: (dest: string) => `kuruldu: ${dest}`,
    blocked: 'ENGELLENDİ',
    needsAck: 'onay gerekiyor',
    error: 'hata',
    help: `kullanım:
  anafor ext check                        kurulu skill/MCP'lerin tarama ve kayıt durumu
  anafor ext list                         kayıtlı eklentiler
  anafor ext add <dizin|git-url> [--path alt/dizin] [--name ad] [--user] [--accept-risk]
                                          skill'i SkillSpector ile tarar, geçerse kurar
  anafor ext add-mcp <ad> --source <dizin|git-url> [--accept-risk] -- <komut> [arg…]
                                          MCP sunucusunun kaynağını tarar, geçerse .mcp.json'a ekler
  anafor ext adopt <ad> [--user] [--accept-risk]
                                          zaten kurulu bir skill'i yerinde tarar ve kaydeder
  anafor ext remove <ad> [--user] [--mcp] kaydı siler (dosyalara dokunmaz)
Politika: HIGH/CRITICAL ve tarama hatası engellenir; CAUTION yalnızca --accept-risk ile (kullanıcı onayı).`,
    noneInstalled: 'Kurulu yerel skill veya proje MCP sunucusu yok.',
    blockedCount: (n: number) =>
      `${n} eklenti engelli. Skill için: anafor ext adopt <ad> [--user]; MCP için: anafor ext add-mcp … ile yeniden ekleyin.`,
    noneRegistered: 'Kayıtlı eklenti yok.',
    riskAccepted: ' (risk onaylı)',
    removed: (name: string) => `${name}: kayıt silindi`,
    notFound: (name: string) => `${name}: kayıt yok`,
  },

  gate: {
    scanFailed: (e: string) => `tarama başarısız (fail-closed): ${e}`,
    label: (score: number, severity: string, rec: string) => `skor ${score} ${severity} ${rec}`,
    blocked: (label: string) => `${label}: kurulamaz`,
    riskAccepted: (label: string) => `${label}: risk açıkça onaylandı`,
    needsAck: (label: string) => `${label}: bulguları inceleyip --accept-risk ile onaylayın`,
    sourceMissing: (source: string) => `kaynak dizin bulunamadı: ${source}`,
    cloneFailed: (e: string) => `git clone başarısız: ${e}`,
    noSkillMd: (dir: string) => `${dir} içinde SKILL.md yok`,
    skillMdMissing: 'SKILL.md bulunamadı',
    multipleSkills: (list: string) => `birden çok skill var; --path ile seçin: ${list}`,
    destExists: (dest: string, cmd: string) =>
      `${dest} zaten var ve kayıtlı değil: önce \`${cmd}\` ile taratın`,
    emptyCommand: 'komut boş',
    reservedName: '"anafor" adı ayrılmış',
  },

  skillspector: {
    notJson: 'SkillSpector raporu JSON değil',
    noRisk: 'SkillSpector raporunda risk_assessment yok',
    spawnFailed: (e: string) => `SkillSpector çalıştırılamadı: ${e}`,
    failed: (code: string, msg: string) => `SkillSpector hata verdi (çıkış ${code}): ${msg}`,
  },

  guard: {
    skillOk: 'kayıtlı skill',
    mcpOk: 'kayıtlı MCP',
    changed: 'tarandıktan sonra DEĞİŞMİŞ',
    unscanned: 'SkillSpector ile taranmamış',
    mcpChanged: 'komutu kayıttan farklı',
    skillBlocked: (name: string, state: string, cmd: string) =>
      `ANAFOR eklenti kapısı: '${name}' skill'i ${state}. Kullanıcıdan \`${cmd}\` çalıştırmasını isteyin.`,
    mcpBlocked: (server: string, state: string) =>
      `ANAFOR eklenti kapısı: '${server}' MCP sunucusu ${state}. ${GUIDE}`,
    directWrite: `ANAFOR eklenti kapısı: skill/MCP dosyalarına doğrudan yazılamaz. ${GUIDE}`,
    acceptRisk:
      'ANAFOR eklenti kapısı: CAUTION riskini yalnızca kullanıcı onaylayabilir. Bulguları kullanıcıya gösterin; onaylarsa komutu kendi terminalinde çalıştırsın.',
    installCmd: (what: string) =>
      `ANAFOR eklenti kapısı: '${what}' doğrudan kullanılamaz. ${GUIDE}`,
  },

  director: {
    why: {
      redirect: 'çıktı yönlendirmesi (>)',
      fsCommand: 'dosya sistemi komutu',
      inPlace: 'yerinde düzenleme (-i)',
      gitMutation: 'çalışma ağacını değiştiren git komutu',
      psCmdlet: 'dosya değiştiren PowerShell cmdlet',
      dotnetWrite: '.NET dosya yazımı',
      scriptWrite: 'betik içinde dosya yazımı',
    },
    deny: (what: string) =>
      `ANAFOR yönetici modu: ${what}. Sen yöneticisin; işçiliği işçiye ver: ` +
      `anafor MCP aracı job_dispatch (düzeltme için job_request_changes). ` +
      `Gerçek bir pürüz varsa (işçinin çözemediği küçük ve net sorun) önce anafor MCP aracı intervene ile gerekçeli, süreli izin al.`,
    outside: 'proje dışı',
    allowedPath: 'izinli yol',
    grant: (id: string) => `müdahale izni ${id}`,
    editForbidden: (rel: string) => `'${rel}' dosyasını doğrudan düzenleme yasak`,
    activeGrant: 'aktif müdahale izni',
    shellForbidden: (why: string) => `dosya değiştiren shell komutu (${why})`,
  },

  sessionStart: {
    managed: (mode: string) => `[Anafor] Bu proje Anafor yönetiminde (director_mode: ${mode}).`,
    role: 'Sen YÖNETİCİSİN: planla, anafor MCP aracı job_dispatch ile işçiye dağıt, incele, kabul et. Kod dosyalarını kendin düzenleme; pürüzde intervene.',
    board: (tasks: number, active: number, review: number, grants: number) =>
      `Açık görev: ${tasks} · çalışan iş: ${active} · inceleme bekleyen: ${review} · aktif müdahale: ${grants}`,
    awaitingReview: (id: string, worker: string, role: string) =>
      `- inceleme bekliyor: ${id} (${worker}, ${role})`,
    extBlocked: (n: number, list: string) =>
      `⚠ Eklenti kapısı: ${n} skill/MCP taranmamış veya değişmiş (${list}); çağrıları engellenir. Kullanıcı: anafor ext check`,
  },

  setupLib: {
    settingsInvalid: 'settings.json okunamadı (geçersiz JSON); elle ekleyin',
    statusAlready: 'Anafor statusLine zaten kurulu',
    statusOther: 'başka bir statusLine var; korunuyor',
    statusUpdated: 'statusLine güncellendi (yedek: settings.json.anafor-backup)',
    statusAdded: 'statusLine eklendi (yedek: settings.json.anafor-backup)',
    hints: {
      gitleaks:
        'İsteğe bağlı gizli bilgi tarayıcısı: gitleaks v8.30.1 (gh release download + checksum; docs/kurulum.md)',
      codex: 'npm install -g @openai/codex  →  codex login',
      'claude-lite':
        'Claude Code kurulu olmalı: https://claude.com/claude-code  →  claude auth login',
      gemini: 'Yalnızca API anahtarıyla: npm install -g @google/gemini-cli + GEMINI_API_KEY',
      opencode:
        'https://opencode.ai  →  anafor.config.json: workers.opencode.model (API anahtarı, yerel model veya ChatGPT planı)',
      local:
        'Ollama (https://ollama.com) veya LM Studio  →  anafor.config.json: workers.local.model',
      antigravity:
        'Koşullar gri alan: yalnızca workers.antigravity.enabled + acknowledge_terms ile; API anahtarı önerilir',
    },
  },

  adapters: {
    windowsSandbox: (mode: string) =>
      `Windows sandbox "${mode}": işçi alt süreç başlatamayabilir (spawn EPERM), ` +
      'testler çalışmaz. Öneri: anafor.config.json → workers.codex.windows_sandbox = "elevated"',
    sandboxDefault: 'varsayılan',
    codexLogin: 'codex oturum açılmamış: `codex login`',
    geminiKey:
      'Gemini CLI yalnızca API anahtarıyla (GEMINI_API_KEY); kişisel hesap girişleri 2026-06-18’de kapandı',
    geminiMissing: 'gemini CLI kurulu değil',
    geminiAuth:
      'Gemini ayarlarında kimlik yöntemi seçili değil: ~/.gemini/settings.json → "security": { "auth": { "selectedType": "gemini-api-key" } }',
    agyTerms:
      'Antigravity koşulları gri alan: workers.antigravity.acknowledge_terms=true gerekli (API anahtarı önerilir)',
    agyMissing: 'agy kurulu değil',
    opencodeModel: 'workers.opencode.model ayarlanmalı (provider/model)',
    opencodeAnthropic:
      'anthropic/* modelleri OpenCode üzerinden yalnızca API anahtarıyla (allow_anthropic_api); Claude aboneliği için claude-lite kullanın',
    opencodeMissing: 'opencode kurulu değil',
    localNoModel: (model: string, list: string) => `model yok: ${model} (mevcut: ${list})`,
    localUnreachable: (url: string, e: string) => `${url} erişilemiyor: ${e}`,
  },
};

export type Messages = typeof tr;

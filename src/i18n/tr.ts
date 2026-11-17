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
};

export type Messages = typeof tr;

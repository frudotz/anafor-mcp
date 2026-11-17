# Anafor kurulumu (yeni bilgisayar, ~5 dakika)

## 1. Ön koşullar

| Bileşen | Neden | Kurulum |
|---|---|---|
| **Node.js 24+** | Anafor çalışma zamanı | https://nodejs.org (Windows: `winget install OpenJS.NodeJS`) |
| **git** | worktree izolasyonu | https://git-scm.com |
| **Claude Code** | beyin (yönetici) | https://claude.com/claude-code → `claude auth login` |
| En az bir işçi | işi yapan ajan | aşağıya bakın |

İşçiler (en az biri):

| İşçi | Kurulum |
|---|---|
| Codex (önerilen) | `npm install -g @openai/codex` → `codex login` |
| Claude Haiku (`claude-lite`) | Ek kurulum yok; Claude Code yeterli |
| Yerel model | Ollama (https://ollama.com) veya LM Studio → `anafor.config.json` |
| OpenCode / Gemini / Antigravity | deneysel; koşullar için [kullanim.md](kullanim.md#8b-işçiler-ve-kullanım-koşulları) |

### İsteğe bağlı: gitleaks (önerilen)

`evidence_generate`, gitleaks PATH'teyse yerleşik tarayıcıya ek olarak onu da çalıştırır. Gitleaks, yerleşik tarayıcının kaçırdığı tırnaksız ve yüksek entropili anahtarları da yakalar. Doğrulanmış sürüm **v8.30.1**; checksum ile kurun:

```bash
gh release download v8.30.1 --repo gitleaks/gitleaks --pattern "gitleaks_8.30.1_<os>_<arch>.*" --pattern "gitleaks_8.30.1_checksums.txt"
sha256sum -c --ignore-missing gitleaks_8.30.1_checksums.txt   # eşleşmeli
```

### Windows: Codex sandbox modu (önemli)

Codex'in Windows'taki varsayılan **unelevated** sandbox'ı isimli pipe oluşturmaya izin vermez. Bu yüzden işçi içinden başlatılan, pipe'lı stdio kullanan her alt süreç `spawn EPERM` ile düşer: `npm test`, vitest/jest, derleyiciler. Sonuçta Codex testleri çalıştıramaz. **elevated** sandbox ayrı `CodexSandbox*` hesaplarıyla çalışır ve bu sorunu yaşamaz.

```json
{ "workers": { "codex": { "windows_sandbox": "elevated" } } }
```

- Ayar yalnızca Anafor'un Codex işlerine uygulanır (`-c windows.sandbox="elevated"`); `~/.codex/config.toml` dosyana dokunulmaz.
- elevated mod bir kez yönetici onayıyla kurulum ister (Codex ilk kullanımda sorar). `anafor doctor` mevcut durumu gösterir.
- Proje `AppData` altındaysa sandbox hesabı oraya erişemez; projeyi örneğin Masaüstü veya `C:\src` altında tut.
- Codex ayrıca her `.git` dizinini salt okunur tutar; işçi commit atmaz, commit'i Anafor yapar.

## 2. Anafor'u kur

```bash
npm install -g https://github.com/frudotz/anafor-mcp/releases/latest/download/anafor-mcp.tgz
```

Bu, CI'da derlenmiş sürüm paketidir; kurulumda derleme yapılmaz. Belirli bir sürüm: `…/releases/download/v0.2.0/anafor-mcp-0.2.0.tgz` (SHA-256 değerleri sürümdeki `SHA256SUMS.txt`'de). Doğrulamak için: `anafor version`.

> `npm install -g github:frudotz/anafor-mcp` **kullanmayın**: npm git'ten kurulumda bağımlılıkları kurmadığı için derleme başarısız olur.

> Geliştirici kurulumu (kaynak koddan): `git clone https://github.com/frudotz/anafor-mcp && cd anafor-mcp && npm install && npm link`

## 3. Sihirbazı çalıştır

```bash
cd /projen          # en az bir commit'i olan bir git deposu
anafor setup
```

Sihirbazın adımları:

0. **Dil:** Türkçe veya English. Seçim `~/.anafor/setup.json` dosyasına kaydedilir. Etkileşimsiz kurulumda `--lang tr|en` kullanılır; geçici olarak değiştirmek için `ANAFOR_LANG=en` tanımlanabilir.

1. **Ortam:** Node, git ve Claude Code kontrolü.
2. **İşçiler:** hangileri hazır, oturum ve limit durumu, eksikler için kurulum ipucu.
3. **Plugin:** Anafor plugin'ini üretir. Onay verirsen resmi `claude plugin install` komutuyla Claude Code'a **kalıcı** kurar; böylece `--plugin-dir` gerekmez.
4. **Statusline:** `~/.claude/settings.json`'a durum satırı ekler. Mevcut bir statusLine varsa dokunulmaz; değiştirmeden önce yedek alınır. Satır şunları gösterir:

   ```
   anafor v0.4.0 · ⬆ v0.5.0: anafor update · ⚠ 2 iş başarısız: anafor doctor · Opus 5.5 · 5s %24 · 7g %33
   ```

   - **Sürüm:** kurulu Anafor sürümü.
   - **Yeni sürüm:** varsa güncelleme komutuyla birlikte gösterilir. Denetim 6 saatte bir arka planda yapılır ve statusline'ı bekletmez. Yalnızca herkese açık GitHub Release bilgisi okunur. Kapatmak için `ANAFOR_NO_UPDATE_CHECK=1`.
   - **Kararlılık önerileri:**
     - Plugin CLI'dan eskiyse: `anafor setup`.
     - Son `anafor doctor` sorun bulduysa: `anafor doctor`.
     - Projede son 2 saatte 2'den fazla iş başarısız olduysa: `anafor doctor`.
   - **Model ve Claude limitleri.**
5. **Proje:** bulunduğun git deposunu Anafor'a bağlar (`anafor init`). Varsayılan cevap "hayır"dır.

Etkileşimsiz kurulum: `anafor setup --yes`. Atlamak istediğin adımlar için `--no-plugin`, `--no-statusline` veya `--no-project` ekle.

## Güncelleme

```bash
anafor update          # son sürümü indir, SHA-256 doğrula, kur, plugin'i yenile
anafor update --check  # yalnızca yeni sürüm var mı
```

`anafor update` şu adımları izler:
1. Sürümün `SHA256SUMS.txt` dosyasını ve paketini indirir.
2. Özeti doğrular. Uyuşmazsa hiçbir şey kurulmaz.
3. Paketi `npm install -g` ile kurar.
4. Plugin'i `anafor setup --yes --no-statusline --no-project` ile yeniler.

Ardından Claude Code'u yeniden başlat.

## 4. Kullan

```bash
anafor chat                      # beyin ajanla terminalden konuş
# veya
claude                           # Claude Code içinde: /anafor:plan <hedef>
anafor jobs | anafor watch       # işleri izle
anafor limits                    # oturum/kullanım limitleri
anafor roles set review codex,claude-lite
anafor doctor                    # bölümlere ayrılmış kontrol; sonuç statusline'a yansır
```

## Kullanım koşulları özeti

- Anafor yalnızca **resmi CLI'ları**, senin **kendi oturumunla**, **senin bilgisayarında** çalıştırır. Hiçbir oturum token'ını okumaz, saklamaz, aktarmaz.
- Claude aboneliği yalnızca resmi `claude` ikilisiyle kullanılır. Ortamda `ANTHROPIC_API_KEY` varsa işçi süreçlerinden çıkarılır; aksi halde API faturalanırdı.
- Anafor'u **başkalarına ürün olarak** sunacaksan (kişisel kullanım dışı) API anahtarıyla kimlik doğrulama önerilir; Anthropic, Agent SDK ve ürünler için abonelik girişini önceden onay olmadan kabul etmez.
- Ayrıntı: [kullanim.md](kullanim.md).

## Kaldırma

```bash
claude plugin uninstall anafor@anafor-local   # kalıcı kurulduysa
npm uninstall -g anafor-mcp
# isteğe bağlı: ~/.anafor (limitler, kurulum durumu) ve projelerdeki .anafor/ silinebilir
```

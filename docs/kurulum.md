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

1. **Ortam:** Node, git ve Claude Code kontrolü.
2. **İşçiler:** hangileri hazır, oturum ve limit durumu, eksikler için kurulum ipucu.
3. **Plugin:** Anafor plugin'ini üretir. Onay verirsen resmi `claude plugin install` komutuyla Claude Code'a **kalıcı** kurar; böylece `--plugin-dir` gerekmez.
4. **Statusline:** Claude limitlerinin görünmesi için `~/.claude/settings.json`'a durum satırı ekler. Mevcut bir statusLine varsa dokunulmaz; değiştirmeden önce yedek alınır.
5. **Proje:** bulunduğun git deposunu Anafor'a bağlar (`anafor init`).

Etkileşimsiz kurulum: `anafor setup --yes` (atlamak için `--no-plugin`, `--no-statusline`).

## 4. Kullan

```bash
anafor chat                      # beyin ajanla terminalden konuş
# veya
claude                           # Claude Code içinde: /anafor:plan <hedef>
anafor jobs | anafor watch       # işleri izle
anafor limits                    # oturum/kullanım limitleri
anafor roles set review codex,claude-lite
anafor doctor                    # sorun giderme
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

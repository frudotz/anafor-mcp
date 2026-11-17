# Katkı Rehberi

Bu repoda birden fazla kişi (ve yapay zekâ ajanları) aynı anda çalışır. Aşağıdaki kuralların tek amacı şudur: **kimsenin işi başkasının işini ezmesin, değişiklikler birbirine karışmasın, `main` her zaman çalışır durumda kalsın.**

## 1. Altın kurallar

1. `main`'e **doğrudan push yok**. Her değişiklik bir dal ve Pull Request (PR) ile gelir.
2. **Force push yok**: `main`'e asla; başkasının dalına asla. Kendi dalında yalnızca PR henüz incelenmemişse ve `--force-with-lease` ile.
3. **Başkasının dalına commit atılmaz.** Öneri varsa PR yorumu veya o dala hedefli ayrı bir PR açılır.
4. Geri almak gerekirse **`git revert`** ile yeni bir PR açılır; `reset --hard` veya geçmiş yeniden yazılmaz.
5. İşe başlamadan önce bir **issue açılır veya mevcut issue üstlenilir** (kendine atanır). Aynı iş iki kişide olmaz.

## 2. Dal adlandırma

```
<sahip>/<tür>/<kısa-açıklama>
```

| Parça | Değerler |
|---|---|
| `sahip` | GitHub kullanıcı adı (ör. `frudotz`), yapay zekâ ajanlarının açtığı dallar için `claude` / `codex` |
| `tür` | `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `spike`, `ci` |
| `kısa-açıklama` | küçük harf, tire ile: `codex-adapter`, `job-state-machine` |

Örnekler: `frudotz/feat/router-config`, `claude/feat/codex-adapter`, `arkadas/fix/windows-kill-tree`.

Sahip öneki sayesinde kimin hangi değişikliği yaptığı dal listesinden ve PR listesinden görünür; isim çakışması olmaz.

## 3. Commit mesajları: Conventional Commits

```
<tür>(<kapsam>): <kısa özet, emir kipinde>

<neden ve ne: ayrıntılı açıklama>

Refs: #<issue>
```

- `tür`: dal türleriyle aynı (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`, `perf`).
- `kapsam`: modül adı: `core`, `store`, `runner`, `server`, `adapter-codex`, `hooks`, `git`, `cli`, `schemas`, `plugin`.
- Kırıcı değişiklik: `feat(core)!: ...` ve gövdede `BREAKING CHANGE:` satırı.
- Küçük ve mantıksal commit'ler; "wip", "fix typo 3" gibi mesajlar PR birleşirken squash ile kaybolur ama dal içinde de anlamlı olsun.

## 4. Pull Request akışı

1. `main`'den güncel dal aç: `git switch main && git pull --ff-only && git switch -c <dal>`.
2. Çalış, commit et, `npm run check` yerelde yeşil olsun.
3. Push et, PR aç. PR şablonunu doldur: amaç, değişiklikler, test kanıtı, ilgili issue.
4. **PR başlığı Conventional Commit biçiminde** olur (squash commit mesajı başlıktan oluşur).
5. CI yeşil olmalı. `main` ilerlediyse dalını güncelle: tercihen `git rebase origin/main` (yalnızca kendi dalında), ardından `--force-with-lease`; ya da GitHub'daki **Update branch** düğmesi.
6. **Çakışmaları PR sahibi çözer.** Çözerken diğerinin değişikliğini silmek gerekiyorsa önce PR'da o kişiye sorulur.
7. **İnsan onayı gerekmez.** Birleştirme kapısı CI'dır: iki işletim sisteminde `check` yeşil + dal `main` ile güncel + tüm yorum konuşmaları çözülmüş. Hız için PR açarken `gh pr merge --squash --auto` ile otomatik birleştirme açılabilir; CI geçince kendiliğinden birleşir.
8. Birleştirme yöntemi: **yalnızca squash merge**. `main` geçmişi doğrusal kalır; her PR `main`'de tek commit olur ve kolayca revert edilebilir.
9. Birleşince dal otomatik silinir.

### Yapay zekâ ajanlarının PR'ları
- Claude Code / Codex tarafından üretilen işler `claude/...` veya `codex/...` dallarında, aynı kurallarla PR olarak gelir. PR açıklaması "Generated with Claude Code" satırını içerir.
- Claude (yönetici ajan), repo sahibinin yetkisiyle **tüm katkıcıların** PR'larını kontrol eder ve CI yeşilse birleştirir. Kontrol: kurallara uygunluk (dal adı, başlık, kapsam), başka bir açık PR'ın işini ezmemesi, gizli bilgi olmaması.
- Dal korumasını atlayan birleştirme (`--admin`) kullanılmaz; tek kapı CI'dır.
- İki açık PR aynı dosyalarda çakışıyorsa önce birleşen kazanır; diğer PR'ın sahibi (veya istenirse Claude) dalı `main` üzerine güncelleyip çakışmayı **iki tarafın değişikliğini koruyarak** çözer.

## 5. Kod standartları

- TypeScript, `strict`. Node 24+, ESM.
- Biçimlendirme: Prettier (`npm run format`). CI `format:check` çalıştırır.
- Tip kontrolü: `npm run typecheck`. Testler: `npm test` (vitest).
- `npm run check` = biçim + tip + test. PR açmadan önce çalıştırın.
- Yeni davranış = yeni test. Hata düzeltmesi = önce hatayı yakalayan test.
- Gizli bilgi (token, anahtar, parola) asla commit edilmez.

## 6. Modül sahipliği ve çakışmayı önleme

- Büyük işlere başlamadan issue'da kısa bir plan yazın; aynı dosyalara dokunacak paralel işler varsa koordine edin.
- Ortak arayüzler (`src/adapters/types.ts`, `schemas/`) değişiyorsa ayrı ve küçük bir PR ile önce onu birleştirin; diğer işler onun üzerine kurulsun.
- Şema değişiklikleri sürümlüdür (`worker-result.v2.json`); eski sürüm hemen kaldırılmaz.

## 7. Sürümleme

SemVer. `0.x` döneminde küçük sürüm (minor) kırıcı olabilir; değişiklikler PR başlıklarından derlenir.

## 8. Dokümantasyon

Kısa kullanıcı dokümantasyonu bu repoda (`README.md`, `docs/`). Ayrıntılı tasarım, kararlar (ADR) ve yol haritası projenin özel dokümantasyon kasasında tutulur. Erişim için repo sahibine başvurun.

## 9. Katkı koruması

Her PR'da `Contribution Guard / guard` kontrolü çalışır. Bu kontrol PR'ın diff'ini yalnızca veri olarak inceler ve PR kodunu asla çalıştırmaz. Amaç, kimsenin "Anafor'a katkı" görüntüsü altında zararlı kod yaymasına izin vermemek. Kurallar ve gerekçeleri (G01–G19) [docs/contribution-guard.md](docs/contribution-guard.md) dosyasında.

**Engellenenler (block):**
- kurulum betikleri ve kurulum betikli paketler
- npm kayıt deposu dışından gelen bağımlılıklar
- `eval` ve `new Function`
- indir-ve-çalıştır desenleri
- kimlik bilgisi erişimi veya ortam değişkenlerinin dışarı sızdırılması
- izin atlatma bayrakları
- telemetri
- gizlenmiş kod
- ikili dosyalar
- gizli Unicode karakterler (Trojan Source)
- koda gömülü gizli bilgiler

**Bakımcı incelemesi gerektirenler (review):**
- yeni ya da sürümü değişen bağımlılık
- CI iş akışları
- hassas yollar (`package.json`, `scripts/`, `plugin/`, `src/cli/update.ts`, `src/hooks/`, `src/extensions/`, `src/setup/`, …)
- yeni ağ uç noktaları
- kabuk üzerinden süreç başlatma

Güvenilir katkıcılar (sahip, üye, ortak çalışan) review bulgularıyla birlikte geçer. Dış katkıcıların PR'ı ise bakımcı inceleyip `guard-approved` etiketini eklemeden birleşemez.

PR açmadan önce yerelde çalıştırın: `node scripts/contribution-guard.mjs --base origin/main --head HEAD`.

## 10. doctor ile bulunan sorunların çözümünü paylaşmak

`anafor doctor` ile bulunan bir sorunu Anafor'un kendi kodunda düzelttiyseniz (yerel ayarınızda değil), lütfen PR açın. Düzeltmeniz `anafor update` ile tüm kullanıcılara ulaşır.

Adımlar [docs/sharing-fixes.md](docs/sharing-fixes.md) dosyasında (İngilizce; insanlar ve yapay zekâ ajanları için):
1. Sorunu yeniden üreten bir test yazın.
2. Düzeltmeyi en küçük kapsamda yapın.
3. `npm run check` ve katkı korumasını çalıştırın.
4. PR şablonuna doctor kodunu, kök nedeni ve doğrulamayı yazın.

Güvenlik açıkları için açık PR veya issue açmayın; [SECURITY.md](SECURITY.md) dosyasındaki yolu izleyin.

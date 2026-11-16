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
7. İnceleme: kod sahibi (CODEOWNERS) onayı gerekir. Tüm yorum konuşmaları çözülmeden birleştirilmez.
8. Birleştirme yöntemi: **yalnızca squash merge**. `main` geçmişi doğrusal kalır; her PR `main`'de tek commit olur ve kolayca revert edilebilir.
9. Birleşince dal otomatik silinir.

### Yapay zekâ ajanlarının PR'ları
- Claude Code / Codex tarafından üretilen işler `claude/...` veya `codex/...` dallarında, aynı kurallarla PR olarak gelir. PR açıklaması "Generated with Claude Code" satırını içerir.
- Repo sahibi kendi ajan PR'larını CI yeşil olduktan sonra birleştirebilir. Başka bir katkıcının PR'ını ajan **birleştirmez**; yalnızca sahip onaylar.

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

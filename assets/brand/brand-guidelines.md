# Anafor marka kılavuzu

## Marka fikri

Dört eşdeğer kol bağımsız iş akışlarını, ortadaki negatif alan koordinasyonu anlatır. Sembol Anafor'un ortak görsel işaretidir; işçi sayısını belirtmez. Marka geometrik, teknik, sakin ve güvenilirdir.

## Renkler

| Token | Renk | Kullanım |
|---|---|---|
| `brand.lime` | `#C9F36B` | Birincil amblem |
| `brand.void` | `#0B1016` | Koyu zemin ve ters amblem |
| `brand.surface` | `#121C25` | İkincil koyu yüzey |
| `brand.white` | `#F2F5F7` | Açık zemin ve koyu kilitup yazısı |
| `brand.steel` | `#93A4B2` | İkincil metin |

UI durumu token'ları `colors.json` ve `colors.css` içinde ayrıdır; logoda kullanılmaz.

## Tipografi

Önerilen standart: marka başlıklarında Space Grotesk 700 (gereğinde 600), arayüz ve metinde Inter 400/500/600, teknik etiketlerde JetBrains Mono 400/500. Logotype outline path'tir ve font gerektirmez. Bu fontlar öneridir; SVG'lere yüklenmez.

## Clear space ve boyut

Amblem çevresinde her yönde en az amblem genişliğinin `0.20×W` kadar boşluk bırakın. Sembol dosyalarının viewBox'ı bu güvenli alanı içerir. Yatay kilitupun tamamına aynı boşluk oranını uygulayın. Dijital sembol için 24×24 px alt sınır, 32 px ve üstü tercih edilir. Wordmark'ı yalnızca rahatça okunabildiği boyutta kullanın.

Yatay kilitup, `Logo-Logotype.svg` yerleşimini izler: sembol grubu `translate(491.19 380) scale(.62)` dönüşümünü kullanır; wordmark path'leri dönüşümsüzdür. Stacked varyantta path'lerin eğrileri örneklenerek sınır kutuları hesaplanır. Sembol dönüşümü `translate(-1000.005 0)`, wordmark dönüşümü `translate(-2039.803 1849.986) scale(.62)` olur. Sembol ve wordmark arasındaki dikey boşluk sembol yüksekliğinin %15'i, dış clear space toplam genişliğin %20'sidir. Değerler build betiğinde path geometrisinden yeniden hesaplanır.

## Doğru ve yanlış kullanım

- Doğru: koyu zeminde lime sembol ve açık wordmark; açık zeminde koyu sembol ve wordmark.
- Doğru: oranı koruyarak ölçekleme ve düz, yeterli kontrastlı yüzey.
- Yanlış: esnetme, eğme, perspektif, rastgele döndürme veya path düzenleme.
- Yanlış: glow, gölge, gradient, stroke, düşük opaklık veya farklı kollara farklı renk.
- Yanlış: karmaşık fotoğraf üzerinde korumasız kullanım.

## Dosya seçimi

- Ürün simgesi, avatar ve küçük alan: `svg/anafor-symbol-primary.svg` veya tek renk sembol.
- README: dark/light transparent yatay kilitup; `prefers-color-scheme` için `picture` kullanın.
- Dolu yüzeyli uygulama: dark/light yatay kilitup.
- Kare kompozisyon: `anafor-lockup-stacked.svg`.
- Favicon: `icons/favicon.svg`.
- Sosyal paylaşım kartı: raster betiği koyu zeminde ortalanmış yatay kilitup ve altında tek satır açıklama üretir; açıklama Inter, Segoe UI, Helvetica veya Arial ile raster çıktısında çizilir.

## CSS token örneği

```css
@import url("assets/brand/tokens/colors.css");
.brand-mark { color: var(--brand-lime); background: var(--brand-void); }
```

Dağıtımda lisans ve NOTICE atıflarını koruyun; değiştirilmiş türevleri Anafor'un orijinal sürümü gibi sunmayın.


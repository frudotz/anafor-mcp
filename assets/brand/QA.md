# Marka paket QA

- Kaynak: kasadaki üç onaylı SVG byte byte kopyalandı; SHA-256 değerleri `source/README.md` içinde.
- Kopyalar `.svg.txt` uzantısı taşır; içerikleri orijinallerle byte-identical kalırken G09 metin satırı sınırından muaf tutulur.
- Üretim: `node assets/brand/build/build.mjs`; yalnız Node yerleşik modülleri kullanır ve SVG'leri kaynaktan yeniden üretir.
- Doğrulama: `node assets/brand/build/verify.mjs`; kaynak path d verisini karşılaştırır, Logo-BG ve Logotype için tüm mutlak path koordinatlarını iki ondalıklı kaynak hassasiyetinde ve 0.02 birim toleransta denetler, lockup bbox merkezlerini ve 90° simetri sapmasını raporlar. Stacked sınır kutuları kontrol noktaları değil, örneklenen eğri noktalarından hesaplanır.
- Raster: `node assets/brand/build/raster.mjs <çıktı-dizini>`; Chrome/Chromium headless gerekir. Repo dışı çıktı yolu zorunludur. Sosyal kartta `Orchestration MCP server for frontier AI models` açıklaması SVG text olarak yalnızca geçici raster sayfasına eklenir. `preview/` altında SVG varyantlarının 1000 px önizlemeleri oluşturulur. PNG'ler guard G10 nedeniyle repoda tutulmaz.
- Uygunluk: SVG'ler harici font, CSS, raster veya script içermez. Sosyal kart rasterları çalıştıran kullanıcının verdiği dizine üretilir.
- Kasıtlı not: kaynak path'ler yeniden çizilmedi veya simetri için düzeltilmedi. QA raporu geometri karşılaştırmasını ve simetri ölçümünü gösterir.

---
description: Başlatır ve Anafor geliştirme döngüsünü izler
argument-hint: "<hedef> | --backlog <dosya>"
---
Geliştirme hedefi veya backlog: $ARGUMENTS

Kullanıcıya `auto_resume` isteyip istemediğini sor; varsayılan olarak kullanıcının
belirttiği tercihi kullan. Sonra Anafor MCP `loop_start` aracını çağır; hedef veya
backlog bilgisini ve tercihi ilet. Dönen pid ve durumu bildir.
Kapatma yalnızca kullanıcı açıkça isterse `shutdown_on_finish: true` olarak ilet;
başlangıçta diğer uygulamalardaki kaydedilmemiş verilerin kaybolabileceğini ve
iptal komutunu bildir. Döngü DONE/BLOCKED bittiğinde bilgisayar 120 saniye içinde
kapanır; iptal komutunu (Windows `shutdown /a`, macOS/Linux `shutdown -c`) göster.
Kullanıcı bekleme sırasında `loop_stop` için pause veya stop seçerse kapanma iptal
edilir. Kapanma zaten zamanlandıysa her iki seçenek de işletim sistemi iptal
komutunu dener; başarısız olursa bildirilen komutu elle çalıştırmasını söyle.
Durum için `loop_status`, duraklatmak veya durdurmak için `loop_stop` kullan.

Ölü döngüyü aynı Claude oturumuyla sürdürmek için `anafor loop recover` kullanılır.
Otomatik kurtarma `loop.recover_on_crash` ayarıyla kontrol edilir (varsayılan `true`);
`.anafor/config.json` içinde `false` yaparak kapatabilirsiniz. Tüm arka plan
tetiklerini kapatmak için `ANAFOR_DISABLE_BACKGROUND=1` ayarlayın.

Claude Code kapalıyken Windows bekçisini yalnızca açıkça `anafor loop watchdog
install` komutuyla kurun. Kullanıcı düzeyindeki görev beş dakikada bir gizli pencerede
`.anafor` içindeki VBS sarmalayıcısını çalıştırır. `anafor loop watchdog uninstall`
görevi ve sarmalayıcıyı kaldırır; `anafor loop watchdog status` durumunu gösterir.
Diğer platformlarda bu komut cron ve launchd zamanlayıcı örneklerini yazdırır.

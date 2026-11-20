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

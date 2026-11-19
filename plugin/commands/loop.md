---
description: Başlatır ve Anafor geliştirme döngüsünü izler
argument-hint: "<hedef> | --backlog <dosya>"
---
Geliştirme hedefi veya backlog: $ARGUMENTS

Kullanıcıya `auto_resume` isteyip istemediğini sor; varsayılan olarak kullanıcının
belirttiği tercihi kullan. Sonra Anafor MCP `loop_start` aracını çağır; hedef veya
backlog bilgisini ve tercihi ilet. Dönen pid ve durumu bildir.
Durum için `loop_status`, duraklatmak veya durdurmak için `loop_stop` kullan.

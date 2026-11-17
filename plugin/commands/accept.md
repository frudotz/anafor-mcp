---
description: Görevi kabul kapılarından geçirir ve kapatır
argument-hint: <task_id> <job_id>
---
Argümanlar: $ARGUMENTS

1. `job_result` (anafor MCP) ve `job_diff` (anafor MCP) ile son durumu doğrula. Kabul kriterleri gerçekten karşılandı mı? Testler ilgili mi?
2. Görev `deep` seviyedeyse önce farklı bir işçiye ya da yeni oturuma `review` işi ver ve kritik bulgu olmadığını gör.
3. `task_accept` (anafor MCP) çağır. `failed_gates` doluysa nedenini kullanıcıya bildir ve düzeltme iste.
4. Commit, push veya birleştirme gerekiyorsa: `evidence_generate` → `checkpoint` → `operation_authorize` (branch = çalışma ağacındaki hedef dal, görev dalı değil) → `task_merge` → `operation_record` (commit_hash = birleştirme sonrası HEAD).
5. Kabul edildiyse kalıcı bilgi varsa proje hafızasını (lat.md / dokümantasyon) güncelle ve kullanıcıya kısa rapor ver.

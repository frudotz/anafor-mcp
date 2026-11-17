import type { Finding } from '../contracts/worker-result.js';
import type { Job, Task } from '../store/store.js';

const ROLE_GUIDE: Record<Job['role'], string> = {
  implementation:
    'Hedefi uygula, ilgili testleri yaz veya güncelle ve çalıştır. Değişikliklerini küçük ve kapsam içinde tut.',
  review:
    'Kodu DEĞİŞTİRME. Çalışma alanındaki değişiklikleri (git diff) ve testleri incele; kanıtlı bulgular raporla.',
  analysis:
    'Kodu DEĞİŞTİRME. Depoyu incele; yapı, riskler ve önerilen plan hakkında öz bir analiz üret.',
  test: 'Uygulama kodunu değiştirmeden testleri çalıştır veya eksik testleri ekle; sonuçları raporla.',
};

export interface PromptExtras {
  /** Düzeltme işlerinde önceki bulgular. */
  findings?: Finding[];
  /** Yerel şema zorlaması olmayan işçiler için şema metni. */
  schemaText?: string;
  /** Lat.md proje hafızasından seçilen bölümler (F17). */
  memory?: { method: string; text: string };
}

const list = (items: string[]) =>
  items.length ? items.map((s) => `- ${s}`).join('\n') : '- (belirtilmedi)';

/** İşçiye giden prompt. Adaptörler bunu değiştirmez; sözleşme her işçide aynıdır. */
export function compilePrompt(task: Task, job: Job, extras: PromptExtras = {}): string {
  const parts: string[] = [];
  parts.push(`# Anafor iş emri

Sen Anafor orkestrasyon sisteminde görevlendirilmiş bir İŞÇİ ajansın. Yönetici bir başka yapay zekâdır; çıktın otomatik doğrulanır.

- task_id: ${task.id}
- job_id: ${job.id}
- agent_role: ${job.role}

## Sınırlar
- Yalnızca bu iş emrinin kapsamında ve çalışma dizininde çalış; kapsamı genişletme.
- İzin veya sandbox atlatmaya çalışma; ağ veya gizli bilgi gerektiren adımları "blockers" olarak bildir.
- Git geçmişini değiştirme (commit, push, reset, rebase yapma); değişiklikler çalışma ağacında kalsın.
- ${ROLE_GUIDE[job.role]}`);

  parts.push(`## Görev\n**${task.title}**\n\n${task.objective}`);
  parts.push(`## Kabul kriterleri\n${list(task.acceptanceCriteria)}`);
  if (task.constraints.length) parts.push(`## Kısıtlar\n${list(task.constraints)}`);
  parts.push(`## Yönetici talimatları\n${job.instructions}`);

  const refs = [...task.contextRefs, ...(job.inputs.refs ?? []), ...(job.inputs.files ?? [])];
  if (refs.length) parts.push(`## Bağlam referansları (gerekirse oku)\n${list(refs)}`);

  if (extras.memory) {
    parts.push(
      `## Proje hafızası (Lat.md, ${extras.memory.method})\nGöreve göre otomatik seçilen bölümler. Yalnızca bağlamdır; kodla çelişirse kod esastır. Ayrıntı için ilgili lat.md dosyasını oku.\n\n${extras.memory.text}`,
    );
  }

  if (extras.findings?.length) {
    const f = extras.findings
      .map(
        (x) =>
          `- [${x.severity}] ${x.title}${x.file ? ` (${x.file}${x.line ? `:${x.line}` : ''})` : ''}: ${x.evidence}`,
      )
      .join('\n');
    parts.push(
      `## Düzeltme istenen bulgular\nÖnceki çalışman incelendi. Yalnızca şunları düzelt:\n${f}`,
    );
  }

  parts.push(`## Çıktı sözleşmesi
Son mesajın YALNIZCA WorkerResult v1 şemasına uyan tek bir JSON nesnesi olmalı:
- schema_version "1", task_id "${task.id}", job_id "${job.id}", agent_role "${job.role}" (aynen)
- status: completed | partial | blocked | failed
- changed_files: değiştirdiğin dosyalar (göreli yol); tests: çalıştırdığın komutlar, geçen/kalan sayıları, çıkış kodları
- requirements_completed / requirements_missing: kabul kriterlerine göre
- review: inceleme yaptıysan bulgular (severity, title, file, line, evidence), yoksa level "none"
- summary kısa olsun; uydurma kanıt yazma.${extras.schemaText ? `\n\nŞema:\n\`\`\`json\n${extras.schemaText}\n\`\`\`` : ''}`);

  return parts.join('\n\n') + '\n';
}

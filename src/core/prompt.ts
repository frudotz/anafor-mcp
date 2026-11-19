import type { Finding } from '../contracts/worker-result.js';
import { lang, type Lang } from '../i18n/index.js';
import type { Job, Task } from '../store/store.js';

/**
 * İş emri metinleri (tr/en). Katalogdan ayrı tutulur: bu metinler kullanıcıya değil işçi
 * modele gider ve önbellek dostu önekin parçasıdır (F22); dil değişmedikçe birebir aynıdır.
 * Kimlik satırları (`task_id:` …) iki dilde de aynıdır (işçiler ve sahte işçi bunları okur).
 */
const P = {
  tr: {
    role: {
      implementation:
        'Hedefi uygula, ilgili testleri yaz veya güncelle ve çalıştır. Değişikliklerini küçük ve kapsam içinde tut.',
      review:
        "Kodu DEĞİŞTİRME. Yalnız diff'i ve gerekli aralıkları oku. Kabul ölçütlerini numaralı liste olarak tek tek denetle; her biri için karşılandı/kısmen/karşılanmadı kararı ve kanıt satırı ver. Kanıtlı bulguları findings'e yaz. Test çalıştırma.",
      analysis:
        'Kodu DEĞİŞTİRME. Depoyu incele; yapı, riskler ve önerilen plan hakkında öz bir analiz üret.',
      test: 'Uygulama kodunu değiştirmeden testleri çalıştır veya eksik testleri ekle; sonuçları raporla.',
    },
    completion:
      '- Kabul ölçütlerinin hepsini bu turda bitir. Yalnız gerçek engel varsa partial bildir ve engeli blockers alanına yaz; zaman veya işin büyüklüğü partial nedeni değildir.',
    reviewRule:
      '- Her kabul ölçütüne karşılandı/kısmen/karşılanmadı kararı ver. Kısmen veya karşılanmadı varsa status completed olsa bile findings içine medium+ bulgu ekle.',
    reportLanguage: '- Raporu iş emrinin dilinde yaz (tr ise Türkçe).',
    sandboxRules: `## Sandbox kuralları
- Geçici dosyalar için repo dışı yollar veya /tmp yerine çalışma alanındaki .anafor-tmp/ dizinini kullan. İş sonunda temizlemeyi dene; silinemezse bırak ve rapora yaz.
- Bir komut sandbox nedeniyle reddedilirse (izin, erişim veya kilit), farklı kabuk biçimi, Node betiği ya da çalışma alanı içi yol gibi en az bir alternatif dene. Yalnızca tüm alternatifler tükenince failed bildir.
- Doğrulama komutları çalışmazsa işi bırakma: değişikliği tamamla. Anafor testleri iş sonrasında sandbox dışında çalıştıracak.`,
    none: '- (belirtilmedi)',
    summary:
      'summary en fazla ~1500 karakter: ne yapıldı + açık riskler. Ham log/diff koyma; dosya yolu ver.',
    header: `# Anafor iş emri

Sen Anafor orkestrasyon sisteminde görevlendirilmiş bir İŞÇİ ajansın. Yönetici bir başka yapay zekâdır; çıktın otomatik doğrulanır.

## Sınırlar
- Yalnızca bu iş emrinin kapsamında ve çalışma dizininde çalış; kapsamı genişletme.
- İzin veya sandbox atlatmaya çalışma; ağ veya gizli bilgi gerektiren adımları "blockers" olarak bildir.
- Git geçmişini değiştirme (commit, push, reset, rebase yapma); değişiklikler çalışma ağacında kalsın.`,
    schema: 'Şema:',
    contract: `## Çıktı sözleşmesi
Son mesajın YALNIZCA WorkerResult v1 şemasına uyan tek bir JSON nesnesi olmalı:
- schema_version "1"; kimlik alanları (task_id, job_id, agent_role) aşağıdaki "Kimlik" bölümündeki değerlerle aynen
- status: completed | partial | blocked | failed
- changed_files: değiştirdiğin dosyalar (göreli yol); tests: çalıştırdığın komutlar, geçen/kalan sayıları, çıkış kodları
- requirements_completed / requirements_missing: kabul kriterlerine göre
- review: inceleme yaptıysan bulgular (severity, title, file, line, evidence), yoksa level "none"`,
    noFake: 'Uydurma kanıt yazma.',
    identity: '## Kimlik',
    task: '## Görev',
    criteria: '## Kabul kriterleri',
    constraints: '## Kısıtlar',
    instructions: '## Yönetici talimatları',
    refs: '## Bağlam referansları (gerekirse oku)',
    memory: (method: string) =>
      `## Proje hafızası (Lat.md, ${method})\nGöreve göre otomatik seçilen bölümler. Yalnızca bağlamdır; kodla çelişirse kod esastır. Ayrıntı için ilgili lat.md dosyasını oku.`,
    findings: '## Düzeltme istenen bulgular\nÖnceki çalışman incelendi. Yalnızca şunları düzelt:',
    resumeHeader:
      '# Anafor iş emri (devam)\nAynı oturumdasın: önceki iş emrindeki sınırlar, görev ve çıktı sözleşmesi aynen geçerli. Yalnızca KİMLİK değişti.',
    resumeOutput: (jobId: string) =>
      `## Çıktı\nSon mesajın yalnızca WorkerResult v1 JSON nesnesi; job_id "${jobId}" kullan.`,
  },
  en: {
    role: {
      implementation:
        'Implement the goal, write or update the relevant tests and run them. Keep your changes small and in scope.',
      review:
        'Do NOT modify code. Read only the diff and necessary ranges. Check each acceptance criterion as a numbered list; for each, give met/partly met/not met and a line of evidence. Put evidence-backed findings in findings. Do not run tests.',
      analysis:
        'Do NOT modify code. Study the repository and produce a concise analysis of structure, risks and a proposed plan.',
      test: 'Run the tests or add missing ones without changing application code; report the results.',
    },
    completion:
      '- Complete every acceptance criterion this turn. Report partial only for a real blocker and put it in blockers; time or task size is not a reason for partial.',
    reviewRule:
      '- Decide met/partly met/not met for every acceptance criterion. If any is partly met or not met, add a medium+ finding even when status is completed.',
    reportLanguage: '- Write the report in the job order language (if tr, use Turkish).',
    sandboxRules: `## Sandbox rules
- Use .anafor-tmp/ in the workspace for temporary files instead of /tmp or paths outside the repository. Try to clean it up at the end; if you cannot, leave it and report that.
- If a command is denied by the sandbox (permission, access, or lock), try at least one alternative such as a different shell form, a Node script, or a workspace-local path. Report failed only after all alternatives are exhausted.
- If verification commands cannot run, do not abandon the job: complete the change. Anafor will run tests outside the sandbox after the job.`,
    none: '- (not specified)',
    summary:
      'summary at most ~1500 characters: what was done + open risks. No raw logs/diffs; give file paths.',
    header: `# Anafor job order

You are a WORKER agent assigned by the Anafor orchestration system. The manager is another AI; your output is validated automatically.

## Boundaries
- Work only within the scope of this job order and its working directory; do not expand the scope.
- Do not try to bypass permissions or the sandbox; report steps that need network access or secrets as "blockers".
- Do not rewrite git history (no commit, push, reset, rebase); leave changes in the working tree.`,
    schema: 'Schema:',
    contract: `## Output contract
Your final message must be ONLY a single JSON object that conforms to the WorkerResult v1 schema:
- schema_version "1"; identity fields (task_id, job_id, agent_role) exactly as in the "Identity" section below
- status: completed | partial | blocked | failed
- changed_files: files you changed (relative paths); tests: commands you ran, passed/failed counts, exit codes
- requirements_completed / requirements_missing: against the acceptance criteria
- review: findings if you reviewed (severity, title, file, line, evidence), otherwise level "none"`,
    noFake: 'Never fabricate evidence.',
    identity: '## Identity',
    task: '## Task',
    criteria: '## Acceptance criteria',
    constraints: '## Constraints',
    instructions: '## Manager instructions',
    refs: '## Context references (read if needed)',
    memory: (method: string) =>
      `## Project memory (Lat.md, ${method})\nSections selected automatically for this task. Context only; if it conflicts with the code, the code wins. Read the relevant lat.md file for details.`,
    findings: '## Findings to fix\nYour previous work was reviewed. Fix only these:',
    resumeHeader:
      '# Anafor job order (continued)\nYou are in the same session: the boundaries, task and output contract of the previous job order still apply. Only the IDENTITY changed.',
    resumeOutput: (jobId: string) =>
      `## Output\nYour final message must be only the WorkerResult v1 JSON object; use job_id "${jobId}".`,
  },
} satisfies Record<Lang, unknown>;

type Texts = (typeof P)[Lang];

export interface PromptExtras {
  /** Düzeltme işlerinde önceki bulgular. */
  findings?: Finding[];
  /** Yerel şema zorlaması olmayan işçiler için şema metni. */
  schemaText?: string;
  /** Aynı işçi oturumunun devamı: kısa iş emri (F22). */
  resumed?: boolean;
  /** Lat.md proje hafızasından seçilen bölümler (F17). */
  memory?: { method: string; text: string };
  /** İş emri dili (varsayılan: arayüz dili). */
  lang?: Lang;
  /** Worker sandbox environment discovery and focused review context. */
  environment?: { working: string[]; unavailable: string[]; note?: string };
  reviewContext?: {
    diffSummary: string;
    autoCheck?: { command: string; passed: boolean; summary: string } | null;
  };
}

const list = (items: string[], none: string) =>
  items.length ? items.map((s) => `- ${s}`).join('\n') : none;

/**
 * İşçiye giden prompt. Adaptörler bunu değiştirmez; sözleşme her işçide aynıdır.
 * Sıra önbellek dostudur (F22): aynı roldeki her işte birebir aynı olan önek (kurallar, rol,
 * çıktı sözleşmesi, şema) önce; işe özgü değişken kısım (kimlik, görev, talimat, hafıza) sonra.
 */
export function compilePrompt(task: Task, job: Job, extras: PromptExtras = {}): string {
  const t: Texts = P[extras.lang ?? lang()];
  if (extras.resumed) return compileResumePrompt(task, job, extras, t);
  const parts: string[] = [];
  parts.push(`${t.header}\n- ${t.role[job.role]}\n${t.reportLanguage}`);
  if (job.role === 'implementation' || job.role === 'test') parts.push(t.completion);
  if (job.role === 'review') parts.push(t.reviewRule);
  if (job.role === 'implementation' || job.role === 'test')
    parts.push(`${t.header}\n- ${t.role[job.role]}\n\n${t.sandboxRules}`);
  else parts.push(`${t.header}\n- ${t.role[job.role]}`);
  const schema = extras.schemaText
    ? `\n\n${t.schema}\n\`\`\`json\n${extras.schemaText}\n\`\`\``
    : '';
  parts.push(`${t.contract}\n- ${t.summary} ${t.noFake}${schema}`);

  // ---- işe özgü kısım ----
  parts.push(identity(task, job, t.identity));
  parts.push(`${t.task}\n**${task.title}**\n\n${task.objective}`);
  if (extras.environment)
    parts.push(
      `## Çalışma ortamı\nÇalışan araçlar: ${extras.environment.working.join(', ') || '(yok)'}\nÇalışmayan araçlar: ${extras.environment.unavailable.join(', ') || '(yok)'}\n${extras.environment.note ?? 'Testleri Anafor iş sonrasında sandbox dışında çalıştıracak; çalışmayan araç için alternatif arama.'}`,
    );
  if (extras.reviewContext && (job.role === 'review' || job.role === 'analysis')) {
    const ac = extras.reviewContext.autoCheck;
    const acLine = ac
      ? `${ac.command} → ${ac.passed ? 'geçti' : 'kaldı'} (${ac.summary})`
      : 'sonuç yok';
    parts.push(
      [
        '## Odaklı inceleme',
        'Değişen dosyalar ve diff özeti:',
        extras.reviewContext.diffSummary,
        `Auto_check: ${acLine}`,
        "Testleri çalıştırma, sonuç yukarıda; diff'i incele, büyük dosyaları baştan sona okuma, " +
          'gerektiğinde aralık oku. Salt okunur incelemede komut denemeleri gerekmez; komut çalıştırma.',
      ].join('\n'),
    );
  }
  parts.push(`${t.criteria}\n${list(task.acceptanceCriteria, t.none)}`);
  if (task.constraints.length) parts.push(`${t.constraints}\n${list(task.constraints, t.none)}`);
  parts.push(`${t.instructions}\n${job.instructions}`);

  const refs = [...task.contextRefs, ...(job.inputs.refs ?? []), ...(job.inputs.files ?? [])];
  if (refs.length) parts.push(`${t.refs}\n${list(refs, t.none)}`);

  if (extras.memory) parts.push(`${t.memory(extras.memory.method)}\n\n${extras.memory.text}`);
  const f = findingsBlock(extras.findings, t.findings);
  if (f) parts.push(f);
  return parts.join('\n\n') + '\n';
}

function identity(task: Task, job: Job, heading: string): string {
  return `${heading}\n- task_id: ${task.id}\n- job_id: ${job.id}\n- agent_role: ${job.role}`;
}

function findingsBlock(findings: Finding[] | undefined, heading: string): string | null {
  if (!findings?.length) return null;
  const f = findings
    .map(
      (x) =>
        `- [${x.severity}] ${x.title}${x.file ? ` (${x.file}${x.line ? `:${x.line}` : ''})` : ''}: ${x.evidence}`,
    )
    .join('\n');
  return `${heading}\n${f}`;
}

/**
 * Aynı işçi oturumunun devamı (resume): kurallar, görev ve sözleşme oturum geçmişinde zaten var.
 * Yalnızca yeni kimlik, talimat ve bulgular eklenir ("append, don't edit"; önbellek korunur).
 */
function compileResumePrompt(task: Task, job: Job, extras: PromptExtras, t: Texts): string {
  const parts = [
    t.resumeHeader,
    identity(task, job, t.identity),
    `${t.instructions}\n${job.instructions}`,
  ];
  const f = findingsBlock(extras.findings, t.findings);
  if (f) parts.push(f);
  parts.push(`${t.resumeOutput(job.id)} ${t.summary}`);
  return parts.join('\n\n') + '\n';
}

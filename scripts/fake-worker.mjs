#!/usr/bin/env node
// Deterministik sahte işçi: Codex `exec --json` olay biçimini taklit eder.
// Senaryo, prompt içindeki `[fake:<senaryo>]` işaretiyle seçilir:
//   ok (varsayılan) | fail | rate-limited | invalid | slow | wrong-id
// Kimlikler prompt'taki `task_id: ...`, `job_id: ...`, `agent_role: ...` satırlarından okunur.
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const prompt = Buffer.concat(chunks).toString('utf8');

const pick = (key) => new RegExp(`${key}:\\s*\`?([\\w.-]+)`).exec(prompt)?.[1] ?? 'unknown';
const scenario = /\[fake:([\w-]+)\]/.exec(prompt)?.[1] ?? 'ok';
const outName = /\[fake-file:([\w.-]+)\]/.exec(prompt)?.[1] ?? 'FAKE_OUTPUT.txt';
const resumeIdx = process.argv.indexOf('--resume');
const thread = resumeIdx >= 0 ? process.argv[resumeIdx + 1] : randomUUID();
const outIdx = process.argv.indexOf('-o');
const outFile = outIdx >= 0 ? process.argv[outIdx + 1] : null;

const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
emit({ type: 'thread.started', thread_id: thread });
emit({ type: 'turn.started' });
emit({ type: 'item.completed', item: { type: 'agent_message', text: `sahte işçi: ${scenario}` } });

if (scenario === 'slow') {
  await new Promise((r) => setTimeout(r, 60_000));
}
if (scenario === 'fail') {
  emit({ type: 'error', message: 'sahte hata' });
  emit({ type: 'turn.failed', error: { message: 'sahte hata' } });
  process.exit(1);
}
if (scenario === 'rate-limited') {
  emit({ type: 'error', message: '429 usage limit reached', fatal: true });
  emit({ type: 'turn.failed', error: { message: '429 usage limit reached' } });
  process.exit(1);
}

writeFileSync(outName, `iş ${pick('job_id')} tamamlandı\n`);
emit({
  type: 'item.completed',
  item: { type: 'file_change', changes: [{ path: outName, kind: 'add' }] },
});
emit({
  type: 'item.completed',
  item: { type: 'command_execution', command: 'echo test', exit_code: 0, status: 'completed' },
});

const result = {
  schema_version: '1',
  task_id: pick('task_id'),
  job_id: scenario === 'wrong-id' ? 'J-uydurma' : pick('job_id'),
  agent_role: pick('agent_role'),
  status: scenario === 'partial' ? 'partial' : 'completed',
  summary: `Sahte işçi ${outName} dosyasını oluşturdu.`,
  changed_files: [outName],
  requirements_completed: ['sahte gereksinim'],
  requirements_missing: scenario === 'partial' ? ['testler sandbox nedeniyle çalıştırılamadı'] : [],
  tests:
    scenario === 'partial'
      ? { executed: ['npm test'], passed: 0, failed: 1, exit_codes: [1] }
      : { executed: ['echo test'], passed: 1, failed: 0, exit_codes: [0] },
  review: { level: 'none', critical_count: 0, findings: [] },
  evidence_locations: [],
  blockers: [],
  recommended_next_action: 'incele ve kabul et',
};
const finalText = scenario === 'invalid' ? 'JSON vermeyi unuttum' : JSON.stringify(result);
emit({ type: 'item.completed', item: { type: 'agent_message', text: finalText } });
emit({
  type: 'turn.completed',
  usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
});
if (outFile) writeFileSync(outFile, finalText);

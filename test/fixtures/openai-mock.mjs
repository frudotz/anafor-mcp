// Sahte OpenAI uyumlu sunucu (SSE akışlı). Hesap/anahtar gerektirmeyen gerçek işçi testleri için.
// Kullanım: node openai-mock.mjs [istek-log-dosyası] [port] [mod]
//   mod=text  : doğrudan WorkerResult JSON'u döner
//   mod=tools : önce `write` aracıyla dosya yazdırır, sonra `bash` ile komut çalıştırır, sonra JSON döner
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const log = process.argv[2];
const mode = process.argv[4] || 'text';

function workerResult(all, changed) {
  const pick = (k) => new RegExp(`${k}: \`?([A-Za-z0-9.-]+)`).exec(all)?.[1] ?? 'unknown';
  return JSON.stringify({
    schema_version: '1',
    task_id: pick('task_id'),
    job_id: pick('job_id'),
    agent_role: pick('agent_role'),
    status: 'completed',
    summary: 'sahte model yanıtı',
    changed_files: changed,
    requirements_completed: ['iş'],
    requirements_missing: [],
    tests: { executed: [], passed: 0, failed: 0, exit_codes: [] },
    review: { level: 'none', critical_count: 0, findings: [] },
    evidence_locations: [],
    blockers: [],
    recommended_next_action: 'incele',
  });
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (log) {
      let names = [];
      try {
        names = (JSON.parse(raw).tools ?? []).map((t) => t.function?.name);
      } catch {}
      appendFileSync(log, `${req.method} ${req.url} ${raw.length} tools=${names.join(',')}\n`);
    }
    if (req.url?.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'm1', object: 'model' }] }));
      return;
    }
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {}
    const all = JSON.stringify(body);
    const isTask = all.includes('task_id');
    const msgs = body.messages ?? [];
    const toolResults = msgs.filter((m) => m.role === 'tool').length;
    const tools = (body.tools ?? []).map((t) => t.function?.name);
    // Araç çağrısı planı (yalnızca görev isteklerinde ve araçlar sunulmuşsa)
    let call = null;
    if (isTask && mode === 'tools') {
      if (toolResults === 0 && tools.includes('write'))
        call = {
          name: 'write',
          args: { filePath: 'ANAFOR_TOOL_TEST.txt', content: 'opencode araç testi\n' },
        };
      else if (toolResults === 1 && tools.includes('bash'))
        call = { name: 'bash', args: { command: 'git status --short', description: 'durum' } };
    }
    const text = !isTask
      ? 'Başlık'
      : workerResult(all, mode === 'tools' ? ['ANAFOR_TOOL_TEST.txt'] : []);
    const id = 'chatcmpl-1';
    const chunk = (delta, finish = null, usage) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'm1', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
    const usage = { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 };
    if (!body.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          created: 1,
          model: 'm1',
          choices: [
            { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
          ],
          usage,
        }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(chunk({ role: 'assistant', content: '' }));
    if (call) {
      res.write(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `call_${toolResults}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        }),
      );
      res.write(chunk({}, 'tool_calls', usage));
    } else {
      res.write(chunk({ content: text }));
      res.write(chunk({}, 'stop', usage));
    }
    res.end('data: [DONE]\n\n');
  });
});
server.listen(Number(process.argv[3] || 18099), '127.0.0.1', () => console.log('mock hazır'));

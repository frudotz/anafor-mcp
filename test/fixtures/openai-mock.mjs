// Sahte OpenAI uyumlu sunucu (SSE akışlı). İstekteki task_id/job_id ile geçerli WorkerResult döner.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const log = process.argv[2];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (log) appendFileSync(log, `${req.method} ${req.url} ${raw.length}\n`);
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
    const pick = (k) => new RegExp(`${k}: \`?([A-Za-z0-9.-]+)`).exec(all)?.[1] ?? 'unknown';
    const isTask = all.includes('Anafor iş emri') || all.includes('task_id');
    const text = isTask
      ? JSON.stringify({
          schema_version: '1',
          task_id: pick('task_id'),
          job_id: pick('job_id'),
          agent_role: pick('agent_role'),
          status: 'completed',
          summary: 'sahte model yanıtı',
          changed_files: [],
          requirements_completed: ['analiz'],
          requirements_missing: [],
          tests: { executed: [], passed: 0, failed: 0, exit_codes: [] },
          review: { level: 'none', critical_count: 0, findings: [] },
          evidence_locations: [],
          blockers: [],
          recommended_next_action: 'incele',
        })
      : 'Başlık';
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const id = 'chatcmpl-1';
      const chunk = (delta, finish = null, usage) =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'm1', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
      res.write(chunk({ role: 'assistant', content: '' }));
      res.write(chunk({ content: text }));
      res.write(chunk({}, 'stop', { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }));
      res.end('data: [DONE]\n\n');
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 1,
          model: 'm1',
          choices: [
            { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
        }),
      );
    }
  });
});
server.listen(Number(process.argv[3] || 18099), '127.0.0.1', () => console.log('mock hazır'));

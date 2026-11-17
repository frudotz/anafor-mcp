// Sahte Gemini API (generateContent / streamGenerateContent / countTokens).
// Hesap/anahtar gerektirmeyen gerçek Gemini CLI testleri için. GOOGLE_GEMINI_BASE_URL ile kullanılır.
// Kullanım: node gemini-mock.mjs [istek-log] [port] [mod: text|tools]
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
    summary: 'sahte gemini yanıtı',
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
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {}
    const url = req.url ?? '';
    const tools = (body.tools ?? []).flatMap((t) =>
      (t.functionDeclarations ?? []).map((f) => f.name),
    );
    if (log)
      appendFileSync(
        log,
        `${req.method} ${url.split('?')[0]} ${raw.length} tools=${tools.slice(0, 12).join(',')}\n`,
      );
    res.setHeader('content-type', 'application/json');
    if (url.includes(':countTokens')) {
      res.end(JSON.stringify({ totalTokens: 10 }));
      return;
    }
    const all = JSON.stringify(body);
    const isTask = all.includes('task_id');
    const contents = body.contents ?? [];
    const responses = contents
      .flatMap((c) => c.parts ?? [])
      .filter((p) => p.functionResponse).length;
    let part;
    if (isTask && mode === 'tools' && responses === 0 && tools.includes('write_file')) {
      part = {
        functionCall: {
          name: 'write_file',
          args: { file_path: 'ANAFOR_GEMINI_TEST.txt', content: 'gemini araç testi\n' },
        },
      };
    } else if (isTask) {
      part = { text: workerResult(all, mode === 'tools' ? ['ANAFOR_GEMINI_TEST.txt'] : []) };
    } else {
      // Sınıflandırıcı/yardımcı istekler (ör. JSON bekleyen yönlendirme): nötr JSON
      part = { text: '{"reasoning":"sahte","model_choice":"flash","next_speaker":"user"}' };
    }
    const payload = {
      candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 25, totalTokenCount: 85 },
      modelVersion: 'mock',
    };
    if (url.includes(':streamGenerateContent')) {
      res.setHeader('content-type', 'text/event-stream');
      // Metin yanıtı iki parçaya bölünür (gerçek modeller gibi): istemci birleştirmeli.
      if (part.text && part.text.length > 20) {
        const half = Math.floor(part.text.length / 2);
        const chunk = (text, last) => ({
          ...payload,
          candidates: [
            {
              content: { role: 'model', parts: [{ text }] },
              ...(last ? { finishReason: 'STOP' } : {}),
              index: 0,
            },
          ],
        });
        res.end(
          `data: ${JSON.stringify(chunk(part.text.slice(0, half), false))}\n\n` +
            `data: ${JSON.stringify(chunk(part.text.slice(half), true))}\n\n`,
        );
      } else {
        res.end(`data: ${JSON.stringify(payload)}\n\n`);
      }
    } else {
      res.end(JSON.stringify(payload));
    }
  });
});
server.listen(Number(process.argv[3] || 18199), '127.0.0.1', () =>
  console.log('gemini mock hazır'),
);

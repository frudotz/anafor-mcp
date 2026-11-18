import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../helpers.js';

const SERVER = fileURLToPath(new URL('../../dist/server/main.js', import.meta.url));

function parse(res: unknown): any {
  const r = res as { content: { type: string; text: string }[]; isError?: boolean };
  const body = JSON.parse(r.content[0]!.text);
  return r.isError ? { __error: body } : body;
}

describe.skipIf(!existsSync(SERVER))('MCP sunucusu uçtan uca (stdio)', () => {
  it('araçlar listelenir; görev → dağıt → bekle → sonuç (ayrık runner + sahte işçi)', async () => {
    // job_wait can return before the runner calls store.close(); on Windows, open SQLite/WAL
    // handles can briefly prevent deletion. Use linear backoff for ~5.5 seconds here.
    const t = tempDir('anafor-test-', { maxRetries: 10, retryDelay: 100 });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, ANAFOR_PROJECT_ROOT: t.dir } as Record<string, string>,
    });
    const client = new Client({ name: 'test', version: '0' });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools.map((x) => x.name);
      expect(tools).toEqual(
        expect.arrayContaining(['task_create', 'job_dispatch', 'job_wait', 'job_result']),
      );
      expect(client.getInstructions()).toContain('YÖNETİCİ');

      const task = parse(
        await client.callTool({
          name: 'task_create',
          arguments: { title: 'E2E', objective: 'dosya oluştur', acceptance_criteria: ['var'] },
        }),
      );
      const job = parse(
        await client.callTool({
          name: 'job_dispatch',
          arguments: {
            task_id: task.task_id,
            role: 'implementation',
            worker: 'fake',
            instructions: '[fake:ok]',
          },
        }),
      );
      expect(job.job_id).toMatch(/^J-/);

      let wait: any;
      for (let i = 0; i < 5; i++) {
        wait = parse(
          await client.callTool({
            name: 'job_wait',
            arguments: { job_ids: [job.job_id], timeout_s: 20 },
          }),
        );
        if (wait.still_running.length === 0) break;
      }
      expect(wait.finished[0].state).toBe('needs_review');

      const result = parse(
        await client.callTool({ name: 'job_result', arguments: { job_id: job.job_id } }),
      );
      expect(result.result.status).toBe('completed');

      const err = parse(
        await client.callTool({ name: 'task_status', arguments: { task_id: 'T-yok' } }),
      );
      expect(err.__error.code).toBe('NOT_FOUND');
    } finally {
      await client.close();
      t.cleanup();
    }
  }, 60_000);
});

import { describe, expect, it } from 'vitest';
import { extractJson, validateWorkerResult } from '../../src/contracts/worker-result.js';
import { sampleResult } from '../helpers.js';

const expected = { taskId: 'T-1', jobId: 'J-1', role: 'implementation' as const };

describe('validateWorkerResult', () => {
  it('geçerli sonucu kabul eder', () => {
    const r = validateWorkerResult(sampleResult(), expected);
    expect(r.ok).toBe(true);
  });

  it('eksik alanı reddeder', () => {
    const bad: Record<string, unknown> = { ...sampleResult() };
    delete bad.summary;
    const r = validateWorkerResult(bad, expected);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('summary');
  });

  it('fazla alanı reddeder', () => {
    const r = validateWorkerResult({ ...sampleResult(), extra: 1 }, expected);
    expect(r.ok).toBe(false);
  });

  it('uydurulmuş task_id/job_id reddedilir', () => {
    const r = validateWorkerResult(sampleResult({ job_id: 'J-other' }), expected);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('job_id');
  });

  it('critical_count tutarsızsa yüksek olanı alır ve uyarır', () => {
    const r = validateWorkerResult(
      sampleResult({
        review: {
          level: 'standard',
          critical_count: 0,
          findings: [{ severity: 'critical', title: 'x', file: null, line: null, evidence: 'e' }],
        },
      }),
      expected,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.review.critical_count).toBe(1);
      expect(r.warnings).toHaveLength(1);
    }
  });
});

describe('extractJson', () => {
  it('düz JSON', () => expect(extractJson('{"a":1}')).toEqual({ a: 1 }));
  it('kod bloğu', () => expect(extractJson('Sonuç:\n```json\n{"a":2}\n```')).toEqual({ a: 2 }));
  it('metne gömülü', () => expect(extractJson('tamam {"a":3} bitti')).toEqual({ a: 3 }));
  it('JSON yoksa hata', () => expect(() => extractJson('yok')).toThrow());
});

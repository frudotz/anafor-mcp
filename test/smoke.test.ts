import { describe, expect, it } from 'vitest';
import { ANAFOR_VERSION } from '../src/version.js';

describe('smoke', () => {
  it('sürüm tanımlı', () => {
    expect(ANAFOR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

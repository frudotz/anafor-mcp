import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir } from '../helpers.js';

describe('tempDir cleanup', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['EPERM', 'EBUSY'])('işçide %s olursa dizini bırakıp not yazar', (code) => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const remove = () => {
      throw Object.assign(new Error('denied'), { code });
    };
    expect(() => cleanupTempDir('C:/temp/locked', {}, remove, true)).not.toThrow();
    expect(write).toHaveBeenCalledWith('geçici dizin bırakıldı: C:/temp/locked\n');
  });

  it('işçi dışı ortamda aynı hata kodunu fırlatır', () => {
    const remove = () => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    };
    expect(() => cleanupTempDir('C:/temp/locked', {}, remove, false)).toThrow('denied');
  });

  it('işçide diğer hata kodlarını fırlatır', () => {
    const remove = () => {
      throw Object.assign(new Error('disk'), { code: 'ENOSPC' });
    };
    expect(() => cleanupTempDir('C:/temp/locked', {}, remove, true)).toThrow('disk');
  });
});

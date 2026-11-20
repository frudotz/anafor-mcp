import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir } from '../helpers.js';

describe('tempDir cleanup', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['EPERM', 'EBUSY', 'ENOTEMPTY'])('%s sonunda dizini bırakıp not yazar', (code) => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const remove = vi.fn(() => {
      throw Object.assign(new Error('denied'), { code });
    });
    expect(() =>
      cleanupTempDir('C:/temp/locked', { maxRetries: 2, retryDelay: 0 }, remove),
    ).not.toThrow();
    expect(remove).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledWith('geçici dizin bırakıldı: C:/temp/locked\n');
  });

  it('başarılı olana kadar belirtilen sayıda yeniden dener', () => {
    const remove = vi
      .fn()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      })
      .mockImplementationOnce(() => undefined);
    expect(() =>
      cleanupTempDir('C:/temp/retry', { maxRetries: 3, retryDelay: 0 }, remove),
    ).not.toThrow();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('muayyen sayıda denemeden sonra diğer hata kodlarını fırlatır', () => {
    const remove = () => {
      throw Object.assign(new Error('disk'), { code: 'ENOSPC' });
    };
    expect(() =>
      cleanupTempDir('C:/temp/locked', { maxRetries: 2, retryDelay: 0 }, remove),
    ).toThrow('disk');
  });
});

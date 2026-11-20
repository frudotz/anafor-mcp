import { describe, expect, it } from 'vitest';
import { isRateLimitError } from '../../src/core/rate-limit.js';

describe('isRateLimitError', () => {
  it.each([
    'OpenAI usage limit reached',
    'rate limit exceeded',
    'HTTP 429 Too Many Requests',
    'Claude rate_limit_event status rejected',
    'status 429',
    'code: 429',
    'Too Many Requests',
  ])('classifies %s', (message) => expect(isRateLimitError(message)).toBe(true));
  it.each([
    'authentication failed',
    'permission denied',
    'network timeout',
    'invalid output',
    'worker returned 429 unrelated value',
  ])('does not classify %s', (message) => expect(isRateLimitError(message)).toBe(false));
});

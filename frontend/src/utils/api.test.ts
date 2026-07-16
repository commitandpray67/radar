import { describe, it, expect } from 'vitest';
import { backoffDelay } from './api';

describe('backoffDelay', () => {
  it('doubles from 500ms and caps at 8s', () => {
    expect(backoffDelay(1)).toBe(500);
    expect(backoffDelay(2)).toBe(1000);
    expect(backoffDelay(3)).toBe(2000);
    expect(backoffDelay(4)).toBe(4000);
    expect(backoffDelay(5)).toBe(8000);
    expect(backoffDelay(6)).toBe(8000); // capped
    expect(backoffDelay(10)).toBe(8000);
  });
});

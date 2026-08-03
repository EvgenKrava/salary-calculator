import { describe, it, expect } from 'vitest';
import { round2 } from '../src/money';

describe('round2', () => {
  it('rounds to two decimals', () => {
    expect(round2(10.126)).toBe(10.13);
    expect(round2(10.124)).toBe(10.12);
  });

  it('leaves clean values unchanged', () => {
    expect(round2(10)).toBe(10);
    expect(round2(2.5)).toBe(2.5);
  });

  it('fixes binary floating-point drift', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});

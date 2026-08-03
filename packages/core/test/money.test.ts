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

  it('rounds half away from zero at the half-cent boundary', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(35.855)).toBe(35.86);
    expect(round2(2.345)).toBe(2.35);
    expect(round2(-1.005)).toBe(-1.01);
  });

  it('does not over-round values genuinely below the half cent', () => {
    expect(round2(35.854)).toBe(35.85);
  });
});

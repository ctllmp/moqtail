import { describe, expect, it } from 'vitest';
import { gaussian, mulberry32 } from './prng';

describe('mulberry32', () => {
  it('produces identical sequences for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      expect(a()).toBe(b());
    }
  });

  it('produces different sequences for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    let differences = 0;
    for (let i = 0; i < 100; i++) {
      if (a() !== b()) differences++;
    }
    expect(differences).toBeGreaterThan(95);
  });

  it('returns values in [0, 1)', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 10_000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('gaussian', () => {
  it('has empirical mean and variance close to parameters', () => {
    const rng = mulberry32(2025);
    const mu = 3;
    const sigma = 1.5;
    const N = 100_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const x = gaussian(rng, mu, sigma);
      sum += x;
      sumSq += x * x;
    }
    const mean = sum / N;
    const variance = sumSq / N - mean * mean;
    expect(Math.abs(mean - mu)).toBeLessThan(0.02);
    expect(Math.abs(variance - sigma * sigma)).toBeLessThan(0.05);
  });

  it('is deterministic given seeded prng', () => {
    const a = mulberry32(11);
    const b = mulberry32(11);
    for (let i = 0; i < 100; i++) {
      expect(gaussian(a, 0, 1)).toBe(gaussian(b, 0, 1));
    }
  });
});

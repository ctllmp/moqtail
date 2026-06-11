import { describe, expect, it } from 'vitest';
import { ParticleFilter } from './filter';
import { mulberry32 } from './prng';
import { defaultConfig, type AbrConfig } from './types';

function makeFilter(overrides: Partial<AbrConfig> = {}, seed = 1) {
  const cfg: AbrConfig = { ...defaultConfig, ...overrides };
  return { filter: new ParticleFilter(cfg, mulberry32(seed)), cfg };
}

describe('ParticleFilter', () => {
  it('mean converges near the truth under constant throughput', () => {
    const { filter } = makeFilter({ numParticles: 100 });
    const truthBps = 5_000_000;
    filter.initialize(truthBps);
    for (let i = 0; i < 50; i++) {
      filter.predict();
      filter.update(truthBps);
      filter.maybeResample();
    }
    const mean = filter.meanBps();
    const relErr = Math.abs(mean - truthBps) / truthBps;
    expect(relErr).toBeLessThan(0.1);
  });

  it('tracks a step change in throughput within a few updates', () => {
    const { filter } = makeFilter({ numParticles: 100 });
    filter.initialize(5_000_000);
    for (let i = 0; i < 20; i++) {
      filter.predict();
      filter.update(5_000_000);
      filter.maybeResample();
    }
    for (let i = 0; i < 15; i++) {
      filter.predict();
      filter.update(1_000_000);
      filter.maybeResample();
    }
    const mean = filter.meanBps();
    expect(mean).toBeLessThan(1_500_000);
    expect(mean).toBeGreaterThan(700_000);
  });

  it('effective sample size decreases when weights concentrate, then resample restores it', () => {
    // Disable the upward-outlier guard here so the far-off observation actually
    // reaches `update()` and reshapes the weights — that's the mechanism under
    // test, not outlier rejection.
    const { filter, cfg } = makeFilter({
      numParticles: 50,
      observationSigma: 0.05,
      observationOutlierMultiplier: null,
    });
    filter.initialize(5_000_000);
    filter.predict();
    filter.update(50_000_000); // far-off observation -> concentrated weights
    const essAfter = filter.effectiveSampleSize();
    expect(essAfter).toBeLessThan(cfg.numParticles / 2);
    const resampled = filter.maybeResample();
    expect(resampled).toBe(true);
    const essReset = filter.effectiveSampleSize();
    expect(essReset).toBeCloseTo(cfg.numParticles, 5);
  });

  it('clamps state inside [minBpsClamp, maxBpsClamp]', () => {
    const { filter } = makeFilter({ numParticles: 30, transitionSigma: 2.0 });
    filter.initialize(1_000_000);
    for (let i = 0; i < 100; i++) filter.predict();
    const mean = filter.meanBps();
    expect(mean).toBeGreaterThanOrEqual(defaultConfig.minBpsClamp);
    expect(mean).toBeLessThanOrEqual(defaultConfig.maxBpsClamp);
  });

  it('is deterministic given the same seed and inputs', () => {
    const a = makeFilter({ numParticles: 40 }, 99).filter;
    const b = makeFilter({ numParticles: 40 }, 99).filter;
    a.initialize(3_000_000);
    b.initialize(3_000_000);
    for (let i = 0; i < 30; i++) {
      a.predict();
      b.predict();
      a.update(3_000_000);
      b.update(3_000_000);
      a.maybeResample();
      b.maybeResample();
    }
    expect(a.meanBps()).toBe(b.meanBps());
  });

  it('sampleTrajectories returns the requested shape and stays in clamp', () => {
    const { filter } = makeFilter({ numParticles: 50 });
    filter.initialize(2_000_000);
    for (let i = 0; i < 10; i++) {
      filter.predict();
      filter.update(2_000_000);
      filter.maybeResample();
    }
    const trajs = filter.sampleTrajectories(5, 20);
    expect(trajs.length).toBe(20);
    for (const t of trajs) {
      expect(t.length).toBe(5);
      for (const v of t) {
        expect(v).toBeGreaterThanOrEqual(defaultConfig.minBpsClamp - 1);
        expect(v).toBeLessThanOrEqual(defaultConfig.maxBpsClamp + 1);
      }
    }
  });

  it('rejects upward burst observations beyond k × the current mean', () => {
    const cfg: AbrConfig = { ...defaultConfig, observationOutlierMultiplier: 5 };
    const filter = new ParticleFilter(cfg, mulberry32(11));
    filter.initialize(2_000_000);
    for (let i = 0; i < 8; i++) {
      filter.predict();
      filter.update(2_000_000);
      filter.maybeResample();
    }
    const before = filter.meanBps();
    // A "burst-flush" observation 50× the posterior must be ignored.
    filter.update(100_000_000);
    expect(filter.meanBps()).toBeCloseTo(before, -3);
  });

  it('accepts the observation when the outlier guard is disabled', () => {
    const cfg: AbrConfig = { ...defaultConfig, observationOutlierMultiplier: null };
    const filter = new ParticleFilter(cfg, mulberry32(11));
    filter.initialize(2_000_000);
    for (let i = 0; i < 8; i++) {
      filter.predict();
      filter.update(2_000_000);
      filter.maybeResample();
    }
    const before = filter.meanBps();
    filter.update(100_000_000);
    // With no guard the burst pulls the posterior upward (the exact amount
    // depends on particle/likelihood interactions — just assert it moved).
    expect(filter.meanBps()).toBeGreaterThan(before * 1.5);
  });
});

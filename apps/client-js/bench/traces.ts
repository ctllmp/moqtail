/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { mulberry32, gaussian, type Prng } from '../src/lib/abr/prng';

export interface Trace {
  name: string;
  /** Per-group available throughput in bits per second. */
  bps: number[];
  /** Short human description of what this trace stresses. */
  kind: 'stable' | 'variable' | 'adversarial';
}

/** Coefficient of variation (std / mean) of a throughput series. */
export function coefficientOfVariation(bps: number[]): number {
  const n = bps.length;
  if (n === 0) return 0;
  const mean = bps.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return 0;
  const variance = bps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  return Math.sqrt(variance) / mean;
}

/**
 * Log-normal multiplicative noise around a base throughput. cov controls the
 * spread: ~0.3 is a stable link, >1.0 is a noisy cellular link. Values are
 * clamped to a sane band so a single tail draw cannot produce 0 or absurd bps.
 */
function noisy(base: number, cov: number, rng: Prng): number {
  const sigma = Math.sqrt(Math.log(1 + cov * cov));
  const factor = Math.exp(gaussian(rng, -0.5 * sigma * sigma, sigma));
  const v = base * factor;
  return Math.min(Math.max(v, 50_000), 100_000_000);
}

/** Steady link with low jitter — point estimators should do fine here. */
export function stable(groups: number, baseBps: number, seed: number): Trace {
  const rng = mulberry32(seed);
  const bps = Array.from({ length: groups }, () => noisy(baseBps, 0.25, rng));
  return { name: `stable-${Math.round(baseBps / 1e6)}Mbps`, bps, kind: 'stable' };
}

/** Wandering bandwidth (random walk in log space) with moderate variance. */
export function variable(groups: number, baseBps: number, seed: number): Trace {
  const rng = mulberry32(seed);
  let level = Math.log(baseBps);
  const bps: number[] = [];
  for (let g = 0; g < groups; g++) {
    level += gaussian(rng, 0, 0.18);
    bps.push(noisy(Math.exp(level), 0.55, rng));
  }
  return { name: `variable-${Math.round(baseBps / 1e6)}Mbps`, bps, kind: 'variable' };
}

/** Sharp cliff: high bandwidth, sudden drop, later recovery. */
export function stepCliff(groups: number, highBps: number, lowBps: number): Trace {
  const a = Math.floor(groups / 3);
  const b = Math.floor((2 * groups) / 3);
  const bps = Array.from({ length: groups }, (_, g) =>
    g < a ? highBps : g < b ? lowBps : highBps,
  );
  return { name: 'adversarial-step-cliff', bps, kind: 'adversarial' };
}

/** Fast square-wave oscillation — stresses hysteresis / anti-oscillation. */
export function sawtooth(groups: number, highBps: number, lowBps: number, period = 2): Trace {
  const bps = Array.from({ length: groups }, (_, g) =>
    Math.floor(g / period) % 2 === 0 ? highBps : lowBps,
  );
  return { name: 'adversarial-sawtooth', bps, kind: 'adversarial' };
}

/** Cellular-like trace: heavy log-normal noise (CoV > 1) on a wandering mean. */
export function cellular(groups: number, baseBps: number, seed: number): Trace {
  const rng = mulberry32(seed);
  let level = Math.log(baseBps);
  const bps: number[] = [];
  for (let g = 0; g < groups; g++) {
    level += gaussian(rng, 0, 0.25);
    bps.push(noisy(Math.exp(level), 1.2, rng));
  }
  return { name: 'adversarial-cellular', bps, kind: 'adversarial' };
}

/**
 * Headless equivalent of the `bench/throttle.sh` tc sequence: 5 contiguous
 * 15-group phases at 8 / 4 / 1.5 / 0.6 / 8 Mbps with phase-appropriate noise.
 * Lets the bench evaluate algorithms under the same regime sequence the live
 * browser test uses, without opening a browser.
 */
export function tcScript(seed: number): Trace {
  const rng = mulberry32(seed);
  const phases: Array<{ groups: number; meanBps: number; cov: number }> = [
    { groups: 15, meanBps: 8_000_000, cov: 0.1 }, // unthrottled
    { groups: 15, meanBps: 4_000_000, cov: 0.15 }, // 4 Mbps
    { groups: 15, meanBps: 1_500_000, cov: 0.2 }, // 1.5 Mbps
    { groups: 15, meanBps: 600_000, cov: 0.3 }, // 600 kbps + 1% loss
    { groups: 15, meanBps: 8_000_000, cov: 0.1 }, // recovery
  ];
  const bps: number[] = [];
  for (const ph of phases) for (let i = 0; i < ph.groups; i++) bps.push(noisy(ph.meanBps, ph.cov, rng));
  return { name: 'tc-script', bps, kind: 'adversarial' };
}

/** A default battery of synthetic traces covering the three regimes. */
export function defaultTraces(groups = 120): Trace[] {
  return [
    stable(groups, 5_000_000, 11),
    stable(groups, 2_000_000, 12),
    variable(groups, 5_000_000, 21),
    variable(groups, 3_000_000, 22),
    variable(groups, 4_000_000, 23),
    stepCliff(groups, 8_000_000, 600_000),
    sawtooth(groups, 8_000_000, 750_000, 2),
    cellular(groups, 4_000_000, 31),
    cellular(groups, 2_500_000, 32),
    tcScript(41),
  ];
}

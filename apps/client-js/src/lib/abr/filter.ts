/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { gaussian, type Prng } from './prng';
import type { AbrConfig } from './types';

const WEIGHT_EPSILON = 1e-300;

export class ParticleFilter {
  readonly #cfg: AbrConfig;
  readonly #rng: Prng;
  readonly #logMin: number;
  readonly #logMax: number;
  #x: Float64Array;
  #w: Float64Array;
  #resampleCount = 0;

  constructor(cfg: AbrConfig, rng: Prng) {
    this.#cfg = cfg;
    this.#rng = rng;
    this.#logMin = Math.log(cfg.minBpsClamp);
    this.#logMax = Math.log(cfg.maxBpsClamp);
    this.#x = new Float64Array(cfg.numParticles);
    this.#w = new Float64Array(cfg.numParticles);
  }

  initialize(seedBps: number): void {
    const center = this.#clampLog(Math.log(Math.max(this.#cfg.minBpsClamp, seedBps)));
    const w0 = 1 / this.#cfg.numParticles;
    for (let i = 0; i < this.#cfg.numParticles; i++) {
      this.#x[i] = this.#clampLog(center + gaussian(this.#rng, 0, this.#cfg.initSigma));
      this.#w[i] = w0;
    }
  }

  predict(): void {
    const sigma = this.#cfg.transitionSigma;
    for (let i = 0; i < this.#x.length; i++) {
      this.#x[i] = this.#clampLog(this.#x[i] + gaussian(this.#rng, 0, sigma));
    }
  }

  update(observedBps: number): void {
    if (observedBps <= 0) return;
    // Skip implausible upward bursts (e.g. relay flushing buffered data after
    // a throttle release). The transition model still spreads uncertainty
    // between updates, so a sustained increase still moves the posterior.
    const k = this.#cfg.observationOutlierMultiplier;
    if (k != null && k > 1) {
      const mean = this.meanBps();
      if (mean > 0 && observedBps > k * mean) return;
    }
    const logObs = Math.log(observedBps);
    const inv2sig2 = 1 / (2 * this.#cfg.observationSigma * this.#cfg.observationSigma);
    let sum = 0;
    for (let i = 0; i < this.#w.length; i++) {
      const d = this.#x[i] - logObs;
      const lik = Math.exp(-d * d * inv2sig2);
      const w = this.#w[i] * lik + WEIGHT_EPSILON;
      this.#w[i] = w;
      sum += w;
    }
    if (sum <= 0) {
      const u = 1 / this.#w.length;
      for (let i = 0; i < this.#w.length; i++) this.#w[i] = u;
      return;
    }
    for (let i = 0; i < this.#w.length; i++) this.#w[i] /= sum;
  }

  effectiveSampleSize(): number {
    let s = 0;
    for (let i = 0; i < this.#w.length; i++) s += this.#w[i] * this.#w[i];
    return s > 0 ? 1 / s : 0;
  }

  maybeResample(): boolean {
    const K = this.#w.length;
    if (this.effectiveSampleSize() >= K / 2) return false;
    this.#systematicResample();
    this.#resampleCount++;
    return true;
  }

  meanBps(): number {
    let s = 0;
    for (let i = 0; i < this.#x.length; i++) s += this.#w[i] * Math.exp(this.#x[i]);
    return s;
  }

  resampleCount(): number {
    return this.#resampleCount;
  }

  sampleTrajectories(horizon: number, numTrajectories: number): Float64Array[] {
    const K = this.#w.length;
    const cdf = new Float64Array(K);
    let acc = 0;
    for (let i = 0; i < K; i++) {
      acc += this.#w[i];
      cdf[i] = acc;
    }
    const sigma = this.#cfg.transitionSigma;
    const trajectories: Float64Array[] = new Array(numTrajectories);
    for (let t = 0; t < numTrajectories; t++) {
      const u = this.#rng() * acc;
      let idx = 0;
      while (idx < K - 1 && cdf[idx] < u) idx++;
      let logBps = this.#x[idx];
      const traj = new Float64Array(horizon);
      for (let h = 0; h < horizon; h++) {
        logBps = this.#clampLog(logBps + gaussian(this.#rng, 0, sigma));
        traj[h] = Math.exp(logBps);
      }
      trajectories[t] = traj;
    }
    return trajectories;
  }

  #systematicResample(): void {
    const K = this.#w.length;
    const cdf = new Float64Array(K);
    let acc = 0;
    for (let i = 0; i < K; i++) {
      acc += this.#w[i];
      cdf[i] = acc;
    }
    const step = acc / K;
    const u0 = this.#rng() * step;
    const newX = new Float64Array(K);
    let j = 0;
    for (let i = 0; i < K; i++) {
      const u = u0 + i * step;
      while (j < K - 1 && cdf[j] < u) j++;
      newX[i] = this.#x[j];
    }
    this.#x = newX;
    const u = 1 / K;
    for (let i = 0; i < K; i++) this.#w[i] = u;
  }

  #clampLog(v: number): number {
    if (v < this.#logMin) return this.#logMin;
    if (v > this.#logMax) return this.#logMax;
    return v;
  }
}

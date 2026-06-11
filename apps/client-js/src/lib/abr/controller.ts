/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { MeasurementCollector } from './collector';
import { ParticleFilter } from './filter';
import { mulberry32, type Prng } from './prng';
import { selectTrack } from './selector';
import type { AbrConfig, AbrDecision, ObjectMeasurement, TrackCandidate } from './types';

export interface AbrControllerOptions {
  config: AbrConfig;
  candidates: TrackCandidate[];
  initialTrack: string;
  getBufferedSeconds: () => number;
  switchTrack: (next: string) => void;
  onDecision?: (d: AbrDecision) => void;
  now?: () => number;
}

export class AbrController {
  readonly #cfg: AbrConfig;
  readonly #candidates: TrackCandidate[];
  readonly #getBufferedSeconds: () => number;
  readonly #switchTrack: (next: string) => void;
  readonly #onDecision?: (d: AbrDecision) => void;
  readonly #rng: Prng;
  readonly #now: () => number;
  readonly #collector = new MeasurementCollector();
  readonly #decisions: AbrDecision[] = [];

  #filter: ParticleFilter | null = null;
  #currentTrack: TrackCandidate;
  #bootstrapSamples: number[] = [];
  #groupsSinceSwitch = 0;
  #disposed = false;

  constructor(opts: AbrControllerOptions) {
    if (opts.candidates.length === 0) {
      throw new Error('AbrController requires at least one video candidate');
    }
    const current = opts.candidates.find(c => c.name === opts.initialTrack);
    if (!current) {
      throw new Error(`Initial track "${opts.initialTrack}" not in candidate list`);
    }
    this.#cfg = opts.config;
    this.#candidates = [...opts.candidates].sort((a, b) => a.bitrateBps - b.bitrateBps);
    this.#currentTrack = current;
    this.#getBufferedSeconds = opts.getBufferedSeconds;
    this.#switchTrack = opts.switchTrack;
    this.#onDecision = opts.onDecision;
    this.#rng = mulberry32(this.#cfg.prngSeed);
    this.#now = opts.now ?? (() => performance.now());
  }

  onObjectMeasured(m: ObjectMeasurement): void {
    if (this.#disposed) return;
    this.#collector.ingestObject(m);
  }

  onEndOfGroup(trackName: string, groupId: bigint): void {
    if (this.#disposed) return;
    if (trackName !== this.#currentTrack.name) return;
    const group = this.#collector.finalizeGroup(trackName, groupId);
    if (!group) return;

    if (!this.#filter) {
      this.#bootstrapSamples.push(group.throughputBps);
      if (this.#bootstrapSamples.length >= this.#cfg.bootstrapGroups) {
        const seed = median(this.#bootstrapSamples);
        const f = new ParticleFilter(this.#cfg, this.#rng);
        f.initialize(seed);
        this.#filter = f;
        this.#bootstrapSamples = [];
        this.#groupsSinceSwitch = 0;
      }
      return;
    }

    const filter = this.#filter;
    filter.predict();
    filter.update(group.throughputBps);
    filter.maybeResample();

    const bufferSec = this.#getBufferedSeconds();
    const t0 = this.#now();
    const { bestTrack, perTrackExpectedQoE } = selectTrack(
      this.#candidates,
      this.#currentTrack,
      filter,
      bufferSec,
      this.#cfg,
    );
    const t1 = this.#now();

    const from = this.#currentTrack;
    const canSwitch = this.#groupsSinceSwitch >= this.#cfg.minGroupsBetweenSwitches;
    const wantsSwitch = bestTrack.name !== from.name;
    const reason = !wantsSwitch
      ? 'no_change'
      : !canSwitch
        ? 'hysteresis'
        : bestTrack.bitrateBps > from.bitrateBps
          ? 'switch_up'
          : 'switch_down';

    const decision: AbrDecision = {
      fromTrack: from.name,
      toTrack: reason === 'switch_up' || reason === 'switch_down' ? bestTrack.name : from.name,
      reason,
      expectedQoE: perTrackExpectedQoE[bestTrack.name],
      perTrackExpectedQoE,
      observedThroughputBps: group.throughputBps,
      filterMeanBps: filter.meanBps(),
      bufferSec,
      decisionLatencyMs: t1 - t0,
      timestampMs: t1,
      groupId,
    };
    this.#decisions.push(decision);
    this.#onDecision?.(decision);

    if (reason === 'switch_up' || reason === 'switch_down') {
      this.#currentTrack = bestTrack;
      this.#groupsSinceSwitch = 0;
      this.#collector.resetTrack(from.name);
      if (this.#cfg.resetFilterOnSwitch) {
        this.#filter = null;
        this.#bootstrapSamples = [];
      }
      this.#switchTrack(bestTrack.name);
    } else {
      this.#groupsSinceSwitch++;
    }
  }

  getDecisions(): readonly AbrDecision[] {
    return this.#decisions;
  }

  getCurrentTrack(): TrackCandidate {
    return this.#currentTrack;
  }

  dispose(): void {
    this.#disposed = true;
    this.#filter = null;
    this.#collector.reset();
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
}

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
import type { Abr, AbrConfig, AbrDecision, ObjectMeasurement, TrackCandidate } from './types';

export interface BolaMoqOptions {
  config: AbrConfig;
  candidates: TrackCandidate[];
  initialTrack: string;
  getBufferedSeconds: () => number;
  switchTrack: (next: string) => void;
  onDecision?: (d: AbrDecision) => void;
  now?: () => number;
  /**
   * Target maximum buffer in segments (Q_max from Spiteri et al.). Default 6.
   *
   * The original BOLA paper uses Q_max ∈ [8, 15] for VOD with O(30 s) buffers.
   * MoQ live runs with sub-2 s buffers, where Q_max=10 makes BOLA park at the
   * floor tier (no buffer ever clears the V·γ_p threshold needed to favor
   * higher bitrates) — observed in browser tests. Q_max=6, γ_p=3 is a
   * compromise that lets BOLA climb on a small buffer without becoming
   * over-eager on free-running synthetic buffers.
   */
  qMax?: number;
  /** Stall-vs-quality weight γ_p (Spiteri et al.). Default 3 for MoQ live. */
  gammaP?: number;
}

/**
 * BOLA-MoQ: faithful port of BOLA-BASIC (Spiteri, Urgaonkar, Sitaraman 2020)
 * to MoQ object cadence. Buffer-only adaptation — no throughput estimate.
 *
 * For each candidate m with bitrate r_m, define utility v_m = ln(r_m / r_min)
 * and per-group size S_m = r_m · τ. With Q(t) = buffer_seconds / τ in units of
 * segments, pick
 *     m* = argmax_m  ( V · (v_m + γ_p) - Q(t) ) / S_m
 * where V = (Q_max - 1) / (v_max + γ_p) calibrates the buffer/quality trade-off.
 *
 * This is the algorithm shipped in dash.js and the production default in many
 * streaming stacks — it is the baseline the paper's "BOLA-MoQ" line refers to.
 */
export class BolaMoQ implements Abr {
  readonly #cfg: AbrConfig;
  readonly #candidates: TrackCandidate[];
  readonly #getBufferedSeconds: () => number;
  readonly #switchTrack: (next: string) => void;
  readonly #onDecision?: (d: AbrDecision) => void;
  readonly #now: () => number;
  readonly #collector = new MeasurementCollector();
  readonly #decisions: AbrDecision[] = [];

  readonly #utility: Map<string, number>;
  readonly #V: number;
  readonly #gammaP: number;

  #currentTrack: TrackCandidate;
  #groupsSinceSwitch: number;
  #disposed = false;

  constructor(opts: BolaMoqOptions) {
    if (opts.candidates.length === 0) {
      throw new Error('BolaMoQ requires at least one video candidate');
    }
    const current = opts.candidates.find(c => c.name === opts.initialTrack);
    if (!current) throw new Error(`Initial track "${opts.initialTrack}" not in candidate list`);

    this.#cfg = opts.config;
    this.#candidates = [...opts.candidates].sort((a, b) => a.bitrateBps - b.bitrateBps);
    this.#currentTrack = current;
    this.#getBufferedSeconds = opts.getBufferedSeconds;
    this.#switchTrack = opts.switchTrack;
    this.#onDecision = opts.onDecision;
    this.#now = opts.now ?? (() => performance.now());

    const rMin = this.#candidates[0].bitrateBps;
    this.#utility = new Map();
    let vMax = 0;
    for (const c of this.#candidates) {
      const v = Math.log(c.bitrateBps / rMin);
      this.#utility.set(c.name, v);
      if (v > vMax) vMax = v;
    }
    const qMax = opts.qMax ?? 6;
    this.#gammaP = opts.gammaP ?? 3;
    this.#V = (qMax - 1) / (vMax + this.#gammaP);

    // First decision can switch immediately (matches AbrController/ThroughputAbr).
    this.#groupsSinceSwitch = this.#cfg.minGroupsBetweenSwitches;
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

    const buffer = this.#getBufferedSeconds();
    const Q = buffer / this.#cfg.groupDurationSec;

    const t0 = this.#now();
    let target = this.#candidates[0];
    let bestScore = -Infinity;
    const perTrack: Record<string, number> = {};
    for (const c of this.#candidates) {
      const v = this.#utility.get(c.name) ?? 0;
      const S = c.bitrateBps * this.#cfg.groupDurationSec; // bits per group
      const score = (this.#V * (v + this.#gammaP) - Q) / S;
      perTrack[c.name] = score;
      if (score > bestScore) {
        bestScore = score;
        target = c;
      }
    }
    const t1 = this.#now();

    const canSwitch = this.#groupsSinceSwitch >= this.#cfg.minGroupsBetweenSwitches;
    const wantsSwitch = target.name !== this.#currentTrack.name;
    const reason: AbrDecision['reason'] = !wantsSwitch
      ? 'no_change'
      : !canSwitch
        ? 'hysteresis'
        : target.bitrateBps > this.#currentTrack.bitrateBps
          ? 'switch_up'
          : 'switch_down';

    const decision: AbrDecision = {
      fromTrack: this.#currentTrack.name,
      toTrack:
        reason === 'switch_up' || reason === 'switch_down' ? target.name : this.#currentTrack.name,
      reason,
      // The "expected QoE" here is the BOLA score — different units from PF's,
      // but the panel renders it as a relative-ranking number anyway.
      expectedQoE: bestScore,
      perTrackExpectedQoE: perTrack,
      observedThroughputBps: group.throughputBps,
      // No throughput estimator → emit the most recent group throughput.
      filterMeanBps: group.throughputBps,
      bufferSec: buffer,
      decisionLatencyMs: t1 - t0,
      timestampMs: t1,
      groupId,
    };
    this.#decisions.push(decision);
    this.#onDecision?.(decision);

    if (reason === 'switch_up' || reason === 'switch_down') {
      const from = this.#currentTrack;
      this.#currentTrack = target;
      this.#groupsSinceSwitch = 0;
      this.#collector.resetTrack(from.name);
      this.#switchTrack(target.name);
    } else {
      this.#groupsSinceSwitch++;
    }
  }

  getCurrentTrack(): TrackCandidate {
    return this.#currentTrack;
  }
  getDecisions(): readonly AbrDecision[] {
    return this.#decisions;
  }
  dispose(): void {
    this.#disposed = true;
    this.#collector.reset();
  }
}

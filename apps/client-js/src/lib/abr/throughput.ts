/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { MeasurementCollector } from './collector';
import type { Abr, AbrConfig, AbrDecision, ObjectMeasurement, TrackCandidate } from './types';

export interface ThroughputAbrOptions {
  config: AbrConfig;
  candidates: TrackCandidate[];
  initialTrack: string;
  getBufferedSeconds: () => number;
  switchTrack: (next: string) => void;
  onDecision?: (d: AbrDecision) => void;
  now?: () => number;
  /** Number of past group throughputs averaged. Default 5. */
  windowGroups?: number;
  /** Multiplier on the harmonic-mean estimate before picking a track. Default 0.9. */
  safetyFactor?: number;
}

/**
 * Classical throughput-rule ABR for comparison against {@link AbrController}.
 *
 * On every group boundary it computes the harmonic mean of the last `window`
 * group throughputs, multiplies by `safetyFactor`, and picks the highest
 * bitrate at or below that budget. Hysteresis follows
 * `cfg.minGroupsBetweenSwitches`. No buffer reasoning, no Monte Carlo —
 * deliberately a stripped-down "what does throughput suggest?" baseline.
 */
export class ThroughputAbr implements Abr {
  readonly #cfg: AbrConfig;
  readonly #candidates: TrackCandidate[];
  readonly #getBufferedSeconds: () => number;
  readonly #switchTrack: (next: string) => void;
  readonly #onDecision?: (d: AbrDecision) => void;
  readonly #now: () => number;
  readonly #window: number;
  readonly #safety: number;
  readonly #collector = new MeasurementCollector();
  readonly #decisions: AbrDecision[] = [];
  readonly #history: number[] = [];

  #currentTrack: TrackCandidate;
  #groupsSinceSwitch: number;
  #disposed = false;

  constructor(opts: ThroughputAbrOptions) {
    if (opts.candidates.length === 0) {
      throw new Error('ThroughputAbr requires at least one video candidate');
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
    this.#now = opts.now ?? (() => performance.now());
    this.#window = Math.max(1, opts.windowGroups ?? 5);
    this.#safety = opts.safetyFactor ?? 0.9;
    // Start outside the hysteresis window so the first decision can switch.
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

    this.#history.push(group.throughputBps);
    if (this.#history.length > this.#window) this.#history.shift();
    const harmonic =
      this.#history.length /
      this.#history.reduce((acc, v) => acc + 1 / Math.max(1, v), 0);
    const budget = harmonic * this.#safety;

    const t0 = this.#now();
    let target = this.#candidates[0];
    for (const c of this.#candidates) if (c.bitrateBps <= budget) target = c;
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
      toTrack: reason === 'switch_up' || reason === 'switch_down' ? target.name : this.#currentTrack.name,
      reason,
      // ThroughputAbr does not optimise expected QoE; leave these zero so the
      // panel renders an empty per-track section instead of fake numbers.
      expectedQoE: 0,
      perTrackExpectedQoE: {},
      observedThroughputBps: group.throughputBps,
      filterMeanBps: harmonic,
      bufferSec: this.#getBufferedSeconds(),
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

/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Common surface implemented by every ABR algorithm in this directory. The
 * player wires the same callbacks regardless of which algorithm runs, and the
 * AbrPanel renders whatever {@link AbrDecision}s it gets.
 */
export interface Abr {
  onObjectMeasured(m: ObjectMeasurement): void;
  onEndOfGroup(trackName: string, groupId: bigint): void;
  getCurrentTrack(): TrackCandidate;
  getDecisions(): readonly AbrDecision[];
  dispose(): void;
}

export interface ObjectMeasurement {
  trackName: string;
  groupId: bigint;
  objectId: bigint;
  sizeBytes: number;
  arrivalTimeMs: number;
}

export interface GroupMeasurement {
  trackName: string;
  groupId: bigint;
  bytes: number;
  durationMs: number;
  throughputBps: number;
}

export interface TrackCandidate {
  name: string;
  bitrateBps: number;
  width?: number;
  height?: number;
}

export type AbrSwitchReason = 'initial' | 'switch_up' | 'switch_down' | 'no_change' | 'hysteresis';

export interface AbrDecision {
  fromTrack: string;
  toTrack: string;
  reason: AbrSwitchReason;
  expectedQoE: number;
  perTrackExpectedQoE: Record<string, number>;
  observedThroughputBps: number;
  filterMeanBps: number;
  bufferSec: number;
  decisionLatencyMs: number;
  timestampMs: number;
  groupId: bigint;
}

export interface AbrConfig {
  numParticles: number;
  horizonGroups: number;
  transitionSigma: number;
  observationSigma: number;
  initSigma: number;
  minGroupsBetweenSwitches: number;
  bootstrapGroups: number;
  qoeBitrateWeight: number;
  qoeStallWeight: number;
  qoeSwitchWeight: number;
  groupDurationSec: number;
  prngSeed: number;
  minBpsClamp: number;
  maxBpsClamp: number;
  /**
   * Transport-cancellation deadline tolerance, in seconds. When non-null, a
   * group whose simulated download time exceeds `groupDurationSec + buffer +
   * epsilon` is treated as cancelled by the relay: it yields no bitrate reward,
   * loses one group of playback (stall-equivalent), and the next group inherits
   * the prior switch reference. Paper's §4.4 default is 0.5; null disables.
   */
  transportCancelEpsilonSec: number | null;
  /**
   * If false, the particle-filter posterior is preserved across track switches
   * (only the candidate changes). The default `true` matches the original
   * design where each switch re-bootstraps the filter — kept for the unit test
   * that asserts that behavior.
   */
  resetFilterOnSwitch: boolean;
  /**
   * If set (k > 1), the filter rejects observations larger than `k × meanBps()`
   * as upward outliers (e.g. burst-flushes after a throttle release that briefly
   * deliver buffered data at far above sustainable rates). The transition model
   * keeps propagating uncertainty between updates, so a sustained burst still
   * influences the posterior on the next non-outlier observation. `null`
   * disables the guard.
   */
  observationOutlierMultiplier: number | null;
}

export const defaultConfig: AbrConfig = {
  numParticles: 50,
  horizonGroups: 5,
  transitionSigma: 0.15,
  observationSigma: 0.1,
  initSigma: 0.3,
  minGroupsBetweenSwitches: 3,
  bootstrapGroups: 4,
  qoeBitrateWeight: 1.0,
  qoeStallWeight: 4.3,
  qoeSwitchWeight: 1.0,
  groupDurationSec: 2.0,
  prngSeed: 1,
  minBpsClamp: 50_000,
  maxBpsClamp: 100_000_000,
  // Bench-proven defaults: §4.4 transport-cancellation enabled, and the filter
  // posterior is preserved across switches (was previously reset). The headless
  // ablation on 8 synthetic traces showed this combination beats the original
  // defaults by ~+150% mean QoE and avoids the cellular/sawtooth blow-ups.
  transportCancelEpsilonSec: 0.5,
  resetFilterOnSwitch: false,
  // Reject upward burst-flush observations (e.g. buffered data dump after a
  // throttle release) that would otherwise pin the filter at the upper clamp.
  // 5× the posterior mean is permissive enough to track real recoveries.
  observationOutlierMultiplier: 5,
};

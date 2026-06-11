/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import type { AbrConfig, TrackCandidate } from './types';

const BPS_TO_MBPS = 1e-6;

export interface QoeStepResult {
  /** Reward (Pensieve QoE) earned this group, before/after cancellation. */
  reward: number;
  /** Buffer after this group's playback (seconds). */
  bufferSec: number;
  /** True iff the group was treated as relay-cancelled (§4.4). */
  cancelled: boolean;
  /**
   * The bitrate the caller should propagate as `prevBitrateBps` for the next
   * group. A cancelled group never plays, so the previous bitrate carries over.
   */
  prevBitrateBps: number;
}

/**
 * One Pensieve-QoE group step with optional §4.4 transport cancellation.
 * Pulled out of {@link simulateAndScore} so MCTS can interleave it with tree
 * descent (each tree edge corresponds to one group's track choice).
 */
export function simulateOneGroup(
  candidate: TrackCandidate,
  throughputBps: number,
  bufferSec: number,
  prevBitrateBps: number,
  cfg: AbrConfig,
): QoeStepResult {
  const tau = cfg.groupDurationSec;
  const b = candidate.bitrateBps;
  const bMbps = b * BPS_TO_MBPS;
  const prevMbps = prevBitrateBps * BPS_TO_MBPS;
  const tput = Math.max(1, throughputBps);
  const downloadSec = (b * tau) / tput;
  const eps = cfg.transportCancelEpsilonSec;
  if (eps != null && downloadSec > tau + bufferSec + eps) {
    return {
      reward: -cfg.qoeStallWeight * tau,
      bufferSec: Math.max(0, bufferSec - tau),
      cancelled: true,
      prevBitrateBps,
    };
  }
  const stall = Math.max(0, downloadSec - bufferSec);
  const reward =
    cfg.qoeBitrateWeight * bMbps -
    cfg.qoeStallWeight * stall -
    cfg.qoeSwitchWeight * Math.abs(bMbps - prevMbps);
  return {
    reward,
    bufferSec: Math.max(0, bufferSec - downloadSec) + tau,
    cancelled: false,
    prevBitrateBps: b,
  };
}

/**
 * Pensieve linear QoE (Mao et al.) over a horizon under one simulated
 * throughput trajectory. All bitrate terms are in Mbps so that
 * alpha/gamma carry their canonical scales (alpha = 1, gamma = 1 per
 * Mbps, beta = 4.3 per stall-second).
 *
 * Per simulated group:
 *   downloadSec = (bitrate * groupDurationSec) / throughput
 *   stallSec    = max(0, downloadSec - bufferSec)
 *   bufferSec  := max(0, bufferSec - downloadSec) + groupDurationSec
 *   score     += alpha * b_Mbps
 *              - beta  * stallSec
 *              - gamma * |b_Mbps - prev_Mbps|
 *
 * Transport-cancellation extension (paper §4.4, opt-in):
 *   When `cfg.transportCancelEpsilonSec` is non-null, any group whose
 *   downloadSec exceeds `groupDurationSec + buffer + epsilon` is treated as
 *   cancelled by the relay. The simulator then awards no bitrate reward,
 *   adds a stall-equivalent penalty of `beta * groupDurationSec`, drains the
 *   buffer by `groupDurationSec`, and carries `prevMbps` unchanged (no switch
 *   is realized for a group that never played).
 */
export function simulateAndScore(
  candidate: TrackCandidate,
  trajectoryBps: ArrayLike<number>,
  initialBufferSec: number,
  prevBitrateBps: number,
  cfg: AbrConfig,
): number {
  let buffer = Math.max(0, initialBufferSec);
  let prevBps = prevBitrateBps;
  let score = 0;
  for (let i = 0; i < trajectoryBps.length; i++) {
    const r = simulateOneGroup(candidate, trajectoryBps[i], buffer, prevBps, cfg);
    score += r.reward;
    buffer = r.bufferSec;
    prevBps = r.prevBitrateBps;
  }
  return score;
}

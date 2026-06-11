/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ParticleFilter } from './filter';
import { simulateAndScore } from './qoe';
import type { AbrConfig, TrackCandidate } from './types';

export interface SelectionResult {
  bestTrack: TrackCandidate;
  perTrackExpectedQoE: Record<string, number>;
}

export function selectTrack(
  candidates: readonly TrackCandidate[],
  currentTrack: TrackCandidate | null,
  filter: ParticleFilter,
  bufferSec: number,
  cfg: AbrConfig,
): SelectionResult {
  if (candidates.length === 0) {
    throw new Error('selectTrack called with no candidates');
  }
  const trajectories = filter.sampleTrajectories(cfg.horizonGroups, cfg.numParticles);
  const prevBitrate = currentTrack?.bitrateBps ?? candidates[0].bitrateBps;
  const perTrackExpectedQoE: Record<string, number> = {};
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const c of candidates) {
    let sum = 0;
    for (let t = 0; t < trajectories.length; t++) {
      sum += simulateAndScore(c, trajectories[t], bufferSec, prevBitrate, cfg);
    }
    const mean = sum / trajectories.length;
    perTrackExpectedQoE[c.name] = mean;
    if (mean > bestScore) {
      bestScore = mean;
      best = c;
    }
  }
  return { bestTrack: best, perTrackExpectedQoE };
}

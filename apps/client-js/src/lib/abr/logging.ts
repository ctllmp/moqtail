/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { logger } from '@/lib/logger';
import type { AbrConfig, AbrDecision, TrackCandidate } from './types';

const TAG = 'abr';

interface RunManifest {
  configuredAtMs: number;
  config: AbrConfig;
  candidates: TrackCandidate[];
  initialTrack: string;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() + 'n' : value;
}

// Emitted at warn-level so the default player log filter ('warn') does not
// hide ABR diagnostics. These are infrequent (manifest once per session;
// decisions ~once per group ≈ 2s).
export function logManifest(m: RunManifest): void {
  logger.warn(TAG, 'run-manifest ' + JSON.stringify(m, bigintReplacer));
}

export function logDecision(d: AbrDecision): void {
  logger.warn(TAG, 'decision ' + JSON.stringify(d, bigintReplacer));
}

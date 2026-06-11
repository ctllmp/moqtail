/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import type { GroupMeasurement, ObjectMeasurement } from './types';

interface GroupAccumulator {
  groupId: bigint;
  bytes: number;
  durationMs: number;
  objectCount: number;
}

interface TrackState {
  lastArrivalMs: number | null;
  current: GroupAccumulator | null;
}

export class MeasurementCollector {
  readonly #tracks = new Map<string, TrackState>();

  ingestObject(m: ObjectMeasurement): void {
    let state = this.#tracks.get(m.trackName);
    if (!state) {
      state = { lastArrivalMs: null, current: null };
      this.#tracks.set(m.trackName, state);
    }

    const delta =
      state.lastArrivalMs == null ? 0 : Math.max(0, m.arrivalTimeMs - state.lastArrivalMs);
    state.lastArrivalMs = m.arrivalTimeMs;

    if (!state.current || state.current.groupId !== m.groupId) {
      state.current = { groupId: m.groupId, bytes: 0, durationMs: 0, objectCount: 0 };
    }
    state.current.bytes += m.sizeBytes;
    state.current.durationMs += delta;
    state.current.objectCount += 1;
  }

  finalizeGroup(trackName: string, groupId: bigint): GroupMeasurement | null {
    const state = this.#tracks.get(trackName);
    if (!state || !state.current || state.current.groupId !== groupId) return null;
    const { bytes, durationMs } = state.current;
    state.current = null;
    if (durationMs <= 0 || bytes <= 0) return null;
    const throughputBps = (bytes * 8 * 1000) / durationMs;
    return { trackName, groupId, bytes, durationMs, throughputBps };
  }

  resetTrack(trackName: string): void {
    this.#tracks.delete(trackName);
  }

  reset(): void {
    this.#tracks.clear();
  }
}

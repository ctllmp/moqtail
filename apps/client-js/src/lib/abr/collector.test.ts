import { describe, expect, it } from 'vitest';
import { MeasurementCollector } from './collector';

const track = 'video-720p';

function obj(arrivalTimeMs: number, sizeBytes: number, groupId: bigint, objectId: bigint) {
  return { trackName: track, groupId, objectId, sizeBytes, arrivalTimeMs };
}

describe('MeasurementCollector', () => {
  it('returns null when finalizing an unknown group', () => {
    const c = new MeasurementCollector();
    expect(c.finalizeGroup(track, 0n)).toBeNull();
  });

  it('computes throughput from inter-arrival deltas and accumulated bytes', () => {
    const c = new MeasurementCollector();
    // First object on the track has no prior arrival, so delta is 0.
    c.ingestObject(obj(1000, 1000, 0n, 0n));
    // 100ms later, 2000 bytes
    c.ingestObject(obj(1100, 2000, 0n, 1n));
    // 100ms later, 2000 bytes
    c.ingestObject(obj(1200, 2000, 0n, 2n));

    const m = c.finalizeGroup(track, 0n);
    expect(m).not.toBeNull();
    // bytes accumulated across all three: 5000, duration across deltas: 200ms.
    expect(m!.bytes).toBe(5000);
    expect(m!.durationMs).toBe(200);
    // 5000 bytes * 8 bits/byte / 0.2s = 200_000 bps
    expect(m!.throughputBps).toBeCloseTo(200_000, 0);
  });

  it('produces independent groups across an EOG boundary', () => {
    const c = new MeasurementCollector();
    c.ingestObject(obj(0, 1000, 0n, 0n));
    c.ingestObject(obj(100, 1000, 0n, 1n));
    expect(c.finalizeGroup(track, 0n)).not.toBeNull();

    // Inter-arrival from group 0's last object carries across.
    c.ingestObject(obj(200, 2000, 1n, 0n));
    c.ingestObject(obj(300, 2000, 1n, 1n));
    const g1 = c.finalizeGroup(track, 1n);
    expect(g1).not.toBeNull();
    expect(g1!.bytes).toBe(4000);
    expect(g1!.durationMs).toBe(200);
    expect(g1!.throughputBps).toBeCloseTo(160_000, 0);
  });

  it('isolates per-track state', () => {
    const c = new MeasurementCollector();
    c.ingestObject({
      trackName: 'a',
      groupId: 0n,
      objectId: 0n,
      sizeBytes: 1000,
      arrivalTimeMs: 0,
    });
    c.ingestObject({
      trackName: 'a',
      groupId: 0n,
      objectId: 1n,
      sizeBytes: 1000,
      arrivalTimeMs: 100,
    });
    c.ingestObject({
      trackName: 'b',
      groupId: 0n,
      objectId: 0n,
      sizeBytes: 500,
      arrivalTimeMs: 50,
    });
    c.ingestObject({
      trackName: 'b',
      groupId: 0n,
      objectId: 1n,
      sizeBytes: 500,
      arrivalTimeMs: 100,
    });

    const a = c.finalizeGroup('a', 0n)!;
    const b = c.finalizeGroup('b', 0n)!;
    expect(a.bytes).toBe(2000);
    expect(b.bytes).toBe(1000);
  });

  it('returns null when group had only the first-ever object (zero duration)', () => {
    const c = new MeasurementCollector();
    c.ingestObject(obj(0, 1000, 0n, 0n));
    expect(c.finalizeGroup(track, 0n)).toBeNull();
  });

  it('resetTrack drops accumulated state', () => {
    const c = new MeasurementCollector();
    c.ingestObject(obj(0, 1000, 0n, 0n));
    c.ingestObject(obj(100, 1000, 0n, 1n));
    c.resetTrack(track);
    expect(c.finalizeGroup(track, 0n)).toBeNull();
  });
});

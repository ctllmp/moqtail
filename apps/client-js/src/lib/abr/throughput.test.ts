import { describe, expect, it } from 'vitest';
import { ThroughputAbr } from './throughput';
import { defaultConfig, type AbrConfig, type TrackCandidate } from './types';

const CANDIDATES: TrackCandidate[] = [
  { name: 'low', bitrateBps: 500_000 },
  { name: 'mid', bitrateBps: 2_400_000 },
  { name: 'high', bitrateBps: 5_000_000 },
];

interface Harness {
  abr: ThroughputAbr;
  switches: string[];
  buffer: { value: number };
  feedGroup: (trackName: string, groupId: bigint, throughputBps: number) => void;
}

function makeHarness(initialTrack: string, cfg: Partial<AbrConfig> = {}): Harness {
  const config: AbrConfig = { ...defaultConfig, ...cfg };
  const switches: string[] = [];
  const buffer = { value: 10 };
  let clock = 0;
  const abr = new ThroughputAbr({
    config,
    candidates: CANDIDATES,
    initialTrack,
    getBufferedSeconds: () => buffer.value,
    switchTrack: name => switches.push(name),
    now: () => clock++,
  });
  const feedGroup = (trackName: string, groupId: bigint, throughputBps: number) => {
    const objectsPerGroup = 8;
    const groupBytes = (throughputBps * config.groupDurationSec) / 8;
    const sizePer = groupBytes / objectsPerGroup;
    const deltaMs = (config.groupDurationSec * 1000) / objectsPerGroup;
    for (let i = 0; i < objectsPerGroup; i++) {
      clock += deltaMs;
      abr.onObjectMeasured({
        trackName,
        groupId,
        objectId: BigInt(i),
        sizeBytes: sizePer,
        arrivalTimeMs: clock,
      });
    }
    abr.onEndOfGroup(trackName, groupId);
  };
  return { abr, switches, buffer, feedGroup };
}

describe('ThroughputAbr', () => {
  it('switches up to the highest bitrate at/below budget', () => {
    const h = makeHarness('low', { minGroupsBetweenSwitches: 0 });
    // 10 Mbps measured throughput, safety 0.9 -> 9 Mbps budget -> pick "high" (5 Mbps).
    h.feedGroup('low', 0n, 10_000_000);
    expect(h.switches[0]).toBe('high');
  });

  it('downshifts when the budget falls below the current tier', () => {
    const h = makeHarness('high', { minGroupsBetweenSwitches: 0 });
    // 1 Mbps repeatedly -> harmonic mean ~1 Mbps, budget ~0.9 Mbps -> pick "low".
    for (let g = 0n; g < 5n; g++) h.feedGroup('high', g, 1_000_000);
    expect(h.switches[0]).toBe('low');
  });

  it('respects hysteresis between switches', () => {
    const h = makeHarness('low', { minGroupsBetweenSwitches: 3 });
    // First group can switch (cooldown starts maxed in the constructor).
    h.feedGroup('low', 0n, 10_000_000);
    expect(h.switches).toEqual(['high']);
    // Now flip throughput low; the next three groups should each be blocked
    // by hysteresis (cooldown is 3, so the 4th group is the first eligible).
    h.feedGroup('high', 1n, 200_000);
    h.feedGroup('high', 2n, 200_000);
    h.feedGroup('high', 3n, 200_000);
    expect(h.switches.length).toBe(1);
    // After cooldown elapses, the next group can downshift.
    h.feedGroup('high', 4n, 200_000);
    expect(h.switches.length).toBe(2);
    expect(h.switches[1]).toBe('low');
  });

  it('emits one decision per group with the harmonic-mean estimate', () => {
    const h = makeHarness('low', { minGroupsBetweenSwitches: 999 });
    h.feedGroup('low', 0n, 1_000_000);
    h.feedGroup('low', 1n, 4_000_000);
    const ds = h.abr.getDecisions();
    expect(ds.length).toBe(2);
    // Compute expected harmonic mean from what the collector actually measured
    // (its inter-arrival semantics yield throughputs slightly off the request).
    const t0 = ds[0].observedThroughputBps;
    const t1 = ds[1].observedThroughputBps;
    const expectedHarmonic = 2 / (1 / t0 + 1 / t1);
    expect(ds[1].filterMeanBps).toBeCloseTo(expectedHarmonic, -3);
  });
});

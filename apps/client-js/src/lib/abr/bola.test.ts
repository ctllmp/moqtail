import { describe, expect, it } from 'vitest';
import { BolaMoQ } from './bola';
import { defaultConfig, type AbrConfig, type TrackCandidate } from './types';

const CANDIDATES: TrackCandidate[] = [
  { name: 'low', bitrateBps: 500_000 },
  { name: 'mid', bitrateBps: 2_400_000 },
  { name: 'high', bitrateBps: 5_000_000 },
];

interface Harness {
  abr: BolaMoQ;
  switches: string[];
  buffer: { value: number };
  feedGroup: (trackName: string, groupId: bigint, throughputBps: number) => void;
}

function makeHarness(initialTrack: string, cfg: Partial<AbrConfig> = {}): Harness {
  const config: AbrConfig = { ...defaultConfig, ...cfg };
  const switches: string[] = [];
  const buffer = { value: 0 };
  let clock = 0;
  const abr = new BolaMoQ({
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

describe('BolaMoQ', () => {
  it('chooses the lowest tier when the buffer is empty', () => {
    const h = makeHarness('mid', { minGroupsBetweenSwitches: 0 });
    h.buffer.value = 0;
    h.feedGroup('mid', 0n, 10_000_000);
    expect(h.switches[0]).toBe('low');
  });

  it('chooses the highest tier when the buffer is full', () => {
    const h = makeHarness('low', { minGroupsBetweenSwitches: 0 });
    h.buffer.value = 30; // well past Q_max·τ
    h.feedGroup('low', 0n, 10_000_000);
    expect(h.switches[0]).toBe('high');
  });

  it('respects hysteresis between switches', () => {
    const h = makeHarness('low', { minGroupsBetweenSwitches: 3 });
    h.buffer.value = 30;
    // First group can switch (cooldown is maxed at construction).
    h.feedGroup('low', 0n, 10_000_000);
    expect(h.switches).toEqual(['high']);
    // Now drain the buffer and expect three hysteresis-blocked groups.
    h.buffer.value = 0;
    h.feedGroup('high', 1n, 200_000);
    h.feedGroup('high', 2n, 200_000);
    h.feedGroup('high', 3n, 200_000);
    expect(h.switches.length).toBe(1);
    // Fourth group: cooldown elapsed, switch to lowest.
    h.feedGroup('high', 4n, 200_000);
    expect(h.switches.length).toBe(2);
    expect(h.switches[1]).toBe('low');
  });

  it('decision is purely a function of buffer, not throughput', () => {
    const a = makeHarness('low', { minGroupsBetweenSwitches: 0 });
    a.buffer.value = 25;
    a.feedGroup('low', 0n, 200_000); // measured throughput far below highest bitrate
    const b = makeHarness('low', { minGroupsBetweenSwitches: 0 });
    b.buffer.value = 25;
    b.feedGroup('low', 0n, 50_000_000); // measured throughput abundant
    expect(a.switches[0]).toBe(b.switches[0]);
  });
});

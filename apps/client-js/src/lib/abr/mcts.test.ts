import { describe, expect, it } from 'vitest';
import { McTsAbr } from './mcts';
import { defaultConfig, type AbrConfig, type TrackCandidate } from './types';

const CANDIDATES: TrackCandidate[] = [
  { name: 'low', bitrateBps: 500_000 },
  { name: 'mid', bitrateBps: 2_400_000 },
  { name: 'high', bitrateBps: 5_000_000 },
];

interface Harness {
  abr: McTsAbr;
  switches: string[];
  buffer: { value: number };
  feedGroup: (trackName: string, groupId: bigint, throughputBps: number) => void;
}

function makeHarness(initialTrack: string, cfg: Partial<AbrConfig> = {}): Harness {
  const config: AbrConfig = { ...defaultConfig, ...cfg };
  const switches: string[] = [];
  const buffer = { value: 10 };
  let clock = 0;
  const abr = new McTsAbr({
    config,
    candidates: CANDIDATES,
    initialTrack,
    getBufferedSeconds: () => buffer.value,
    switchTrack: name => switches.push(name),
    now: () => clock++,
    iterations: 30,
    windowGroups: 10,
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

describe('McTsAbr', () => {
  it('switches up on a sustained-high-throughput window', () => {
    const h = makeHarness('low', { minGroupsBetweenSwitches: 0 });
    for (let g = 0n; g < 8n; g++) h.feedGroup('low', g, 12_000_000);
    expect(h.switches.length).toBeGreaterThan(0);
    const last = h.switches[h.switches.length - 1];
    expect(last === 'mid' || last === 'high').toBe(true);
  });

  it('switches down when throughput collapses', () => {
    const h = makeHarness('high', { minGroupsBetweenSwitches: 0 });
    for (let g = 0n; g < 8n; g++) h.feedGroup('high', g, 200_000);
    expect(h.switches.length).toBeGreaterThan(0);
    expect(h.switches[0]).not.toBe('high');
  });

  it('respects hysteresis between switches', () => {
    const h = makeHarness('low', { minGroupsBetweenSwitches: 3 });
    h.feedGroup('low', 0n, 12_000_000);
    expect(h.switches.length).toBe(1);
    const afterFirstSwitch = h.switches.length;
    h.feedGroup(h.switches[0], 1n, 12_000_000);
    h.feedGroup(h.switches[0], 2n, 12_000_000);
    h.feedGroup(h.switches[0], 3n, 12_000_000);
    expect(h.switches.length).toBe(afterFirstSwitch);
  });

  it('per-track expected QoE is monotone in bitrate when throughput is abundant', () => {
    // 12 Mbps sustained: highest tier should win the tree's mean comparison.
    const h = makeHarness('low', { minGroupsBetweenSwitches: 999 });
    for (let g = 0n; g < 6n; g++) h.feedGroup(h.abr.getCurrentTrack().name, g, 12_000_000);
    const ds = h.abr.getDecisions();
    expect(ds.length).toBeGreaterThan(0);
    const lastQoE = ds[ds.length - 1].perTrackExpectedQoE;
    // `high` should outscore `mid` and `low` (the tree found high yields the
    // biggest cumulative reward under a stick-with-it rollout policy).
    expect(lastQoE['high']).toBeGreaterThan(lastQoE['mid']);
    expect(lastQoE['mid']).toBeGreaterThan(lastQoE['low']);
  });

  it('emits one decision per group and records the rollout mean per track', () => {
    const h = makeHarness('mid', { minGroupsBetweenSwitches: 999 });
    // The first decision may switch, so feed each group on whatever track is
    // current right then; the test is about per-call decision emission, not
    // about pinning the controller to a specific track.
    h.feedGroup(h.abr.getCurrentTrack().name, 0n, 2_500_000);
    h.feedGroup(h.abr.getCurrentTrack().name, 1n, 2_500_000);
    const ds = h.abr.getDecisions();
    expect(ds.length).toBe(2);
    expect(Object.keys(ds[1].perTrackExpectedQoE).sort()).toEqual(['high', 'low', 'mid']);
  });
});

import { describe, expect, it } from 'vitest';
import { AbrController } from './controller';
import { defaultConfig, type AbrConfig, type TrackCandidate } from './types';

const CANDIDATES: TrackCandidate[] = [
  { name: 'low', bitrateBps: 500_000 },
  { name: 'mid', bitrateBps: 2_400_000 },
  { name: 'high', bitrateBps: 5_000_000 },
];

interface Harness {
  ctrl: AbrController;
  switches: string[];
  buffer: { value: number };
  feedGroup: (trackName: string, groupId: bigint, throughputBps: number) => void;
}

function makeHarness(initialTrack: string, cfg: Partial<AbrConfig> = {}): Harness {
  const config: AbrConfig = { ...defaultConfig, ...cfg };
  const switches: string[] = [];
  const buffer = { value: 10 };
  let clock = 0;
  const ctrl = new AbrController({
    config,
    candidates: CANDIDATES,
    initialTrack,
    getBufferedSeconds: () => buffer.value,
    switchTrack: name => switches.push(name),
    now: () => clock++,
  });
  // Emit 8 evenly-sized objects per group whose inter-arrival timing
  // yields the requested throughput, then call EOG.
  const feedGroup = (trackName: string, groupId: bigint, throughputBps: number) => {
    const objectsPerGroup = 8;
    const groupBytes = (throughputBps * config.groupDurationSec) / 8;
    const sizePer = groupBytes / objectsPerGroup;
    const deltaMs = (config.groupDurationSec * 1000) / objectsPerGroup;
    for (let i = 0; i < objectsPerGroup; i++) {
      clock += deltaMs;
      ctrl.onObjectMeasured({
        trackName,
        groupId,
        objectId: BigInt(i),
        sizeBytes: sizePer,
        arrivalTimeMs: clock,
      });
    }
    ctrl.onEndOfGroup(trackName, groupId);
  };
  return { ctrl, switches, buffer, feedGroup };
}

describe('AbrController', () => {
  it('makes no decisions while bootstrapping', () => {
    const h = makeHarness('mid');
    for (let g = 0n; g < BigInt(defaultConfig.bootstrapGroups); g++) {
      h.feedGroup('mid', g, 2_500_000);
    }
    expect(h.ctrl.getDecisions().length).toBe(0);
  });

  it('produces a decision per group after bootstrap on the active track only', () => {
    const h = makeHarness('mid');
    const N = defaultConfig.bootstrapGroups + 3;
    for (let g = 0n; g < BigInt(N); g++) {
      h.feedGroup('mid', g, 2_500_000);
    }
    expect(h.ctrl.getDecisions().length).toBe(3);
    // Also confirm we ignore EOG on other tracks.
    h.feedGroup('audio', 100n, 10_000_000);
    expect(h.ctrl.getDecisions().length).toBe(3);
  });

  it('downshifts when throughput collapses, after hysteresis', () => {
    const h = makeHarness('high', { minGroupsBetweenSwitches: 2 });
    // Bootstrap at high throughput.
    for (let g = 0n; g < BigInt(defaultConfig.bootstrapGroups); g++) {
      h.feedGroup('high', g, 6_000_000);
    }
    // Crash the network and shrink the buffer so stalls dominate.
    h.buffer.value = 1;
    let g = BigInt(defaultConfig.bootstrapGroups);
    for (let i = 0; i < 8; i++, g++) {
      h.feedGroup('high', g, 200_000);
      if (h.switches.length > 0) break;
    }
    expect(h.switches.length).toBeGreaterThan(0);
    expect(h.switches[0]).not.toBe('high');
    // The first switch target should be lower bitrate.
    const target = CANDIDATES.find(c => c.name === h.switches[0])!;
    expect(target.bitrateBps).toBeLessThan(5_000_000);
  });

  it('re-bootstraps after a switch when resetFilterOnSwitch=true (legacy mode)', () => {
    const h = makeHarness('high', {
      minGroupsBetweenSwitches: 1,
      resetFilterOnSwitch: true,
    });
    for (let g = 0n; g < BigInt(defaultConfig.bootstrapGroups); g++) {
      h.feedGroup('high', g, 6_000_000);
    }
    h.buffer.value = 1;
    let g = BigInt(defaultConfig.bootstrapGroups);
    while (h.switches.length === 0 && g < 20n) {
      h.feedGroup('high', g, 150_000);
      g++;
    }
    expect(h.switches.length).toBe(1);
    const switchedTo = h.switches[0];
    const beforeReboot = h.ctrl.getDecisions().length;
    // The controller now considers `switchedTo` active. Feed a few groups on it.
    // None of those should produce a decision until bootstrap completes.
    for (let i = 0; i < defaultConfig.bootstrapGroups - 1; i++, g++) {
      h.feedGroup(switchedTo, g, 200_000);
    }
    expect(h.ctrl.getDecisions().length).toBe(beforeReboot);
  });

  it('respects hysteresis: no switch within minGroupsBetweenSwitches', () => {
    const h = makeHarness('high', { minGroupsBetweenSwitches: 5 });
    for (let g = 0n; g < BigInt(defaultConfig.bootstrapGroups); g++) {
      h.feedGroup('high', g, 6_000_000);
    }
    h.buffer.value = 1;
    // Feed only minGroupsBetweenSwitches-1 collapsing-throughput groups.
    for (let i = 0; i < 4; i++) {
      h.feedGroup('high', BigInt(defaultConfig.bootstrapGroups + i), 100_000);
    }
    // Hysteresis must block a switch even though the selector wants one.
    expect(h.switches.length).toBe(0);
    const ds = h.ctrl.getDecisions();
    expect(ds.some(d => d.reason === 'hysteresis')).toBe(true);
  });

  it('does not re-bootstrap after a switch under the default keep-filter mode', () => {
    const h = makeHarness('high', { minGroupsBetweenSwitches: 1 });
    for (let g = 0n; g < BigInt(defaultConfig.bootstrapGroups); g++) {
      h.feedGroup('high', g, 6_000_000);
    }
    h.buffer.value = 1;
    let g = BigInt(defaultConfig.bootstrapGroups);
    while (h.switches.length === 0 && g < 20n) {
      h.feedGroup('high', g, 150_000);
      g++;
    }
    expect(h.switches.length).toBe(1);
    const switchedTo = h.switches[0];
    const beforeReboot = h.ctrl.getDecisions().length;
    // With keep-filter (default), the very next group on the new track must
    // produce a decision immediately — no silent bootstrap window. We only
    // assert on the first group because the controller may switch again on
    // subsequent groups, which would change `currentTrack` and filter out
    // further callbacks that still carry `switchedTo`.
    h.feedGroup(switchedTo, g, 200_000);
    expect(h.ctrl.getDecisions().length).toBe(beforeReboot + 1);
  });

  it('decisions are deterministic under the same seed and inputs', () => {
    const replay = () => {
      const h = makeHarness('mid', { prngSeed: 12345 });
      for (let g = 0n; g < 10n; g++) {
        h.feedGroup('mid', g, 2_500_000);
      }
      return h.ctrl.getDecisions().map(d => d.toTrack + ':' + d.reason);
    };
    expect(replay()).toEqual(replay());
  });
});

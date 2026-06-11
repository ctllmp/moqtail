import { describe, expect, it } from 'vitest';
import { ParticleFilter } from './filter';
import { mulberry32 } from './prng';
import { selectTrack } from './selector';
import { defaultConfig, type AbrConfig, type TrackCandidate } from './types';

const CANDIDATES: TrackCandidate[] = [
  { name: 'low', bitrateBps: 500_000 },
  { name: 'mid', bitrateBps: 2_400_000 },
  { name: 'high', bitrateBps: 5_000_000 },
];

function primeFilter(truthBps: number, cfg: AbrConfig = defaultConfig): ParticleFilter {
  const f = new ParticleFilter(cfg, mulberry32(7));
  f.initialize(truthBps);
  for (let i = 0; i < 20; i++) {
    f.predict();
    f.update(truthBps);
    f.maybeResample();
  }
  return f;
}

describe('selectTrack', () => {
  it('picks the highest-bitrate candidate when throughput vastly exceeds all', () => {
    const f = primeFilter(50_000_000);
    const { bestTrack } = selectTrack(CANDIDATES, CANDIDATES[2], f, 20, defaultConfig);
    expect(bestTrack.name).toBe('high');
  });

  it('picks the lowest-bitrate candidate when throughput is much smaller than all', () => {
    const f = primeFilter(150_000);
    const { bestTrack } = selectTrack(CANDIDATES, CANDIDATES[0], f, 2, defaultConfig);
    expect(bestTrack.name).toBe('low');
  });

  it('picks the middle candidate when throughput is between mid and high', () => {
    const f = primeFilter(2_700_000);
    const { bestTrack } = selectTrack(CANDIDATES, CANDIDATES[1], f, 8, defaultConfig);
    expect(bestTrack.name).toBe('mid');
  });

  it('returns one expected-QoE value per candidate', () => {
    const f = primeFilter(2_000_000);
    const { perTrackExpectedQoE } = selectTrack(CANDIDATES, CANDIDATES[1], f, 8, defaultConfig);
    expect(Object.keys(perTrackExpectedQoE).sort()).toEqual(['high', 'low', 'mid']);
    for (const v of Object.values(perTrackExpectedQoE)) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

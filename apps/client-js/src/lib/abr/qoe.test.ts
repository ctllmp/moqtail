import { describe, expect, it } from 'vitest';
import { simulateAndScore } from './qoe';
import { defaultConfig, type TrackCandidate } from './types';

const LOW: TrackCandidate = { name: 'low', bitrateBps: 500_000 };
const MID: TrackCandidate = { name: 'mid', bitrateBps: 2_000_000 };
const HIGH: TrackCandidate = { name: 'high', bitrateBps: 5_000_000 };

function trajectory(bps: number, length: number): Float64Array {
  const t = new Float64Array(length);
  for (let i = 0; i < length; i++) t[i] = bps;
  return t;
}

// Several of these tests assert the *vanilla* Pensieve QoE behavior (no
// transport-cancellation). They pin the cfg explicitly so flipping the
// defaults does not change their semantics.
const VANILLA = { ...defaultConfig, transportCancelEpsilonSec: null };

describe('simulateAndScore', () => {
  it('is monotone increasing in bitrate when throughput is abundant', () => {
    const traj = trajectory(50_000_000, defaultConfig.horizonGroups);
    const sLow = simulateAndScore(LOW, traj, 10, LOW.bitrateBps, VANILLA);
    const sMid = simulateAndScore(MID, traj, 10, LOW.bitrateBps, VANILLA);
    const sHigh = simulateAndScore(HIGH, traj, 10, LOW.bitrateBps, VANILLA);
    expect(sMid).toBeGreaterThan(sLow);
    expect(sHigh).toBeGreaterThan(sMid);
  });

  it('punishes the high bitrate when throughput cannot sustain it', () => {
    const traj = trajectory(100_000, defaultConfig.horizonGroups);
    const sLow = simulateAndScore(LOW, traj, 2, LOW.bitrateBps, VANILLA);
    const sHigh = simulateAndScore(HIGH, traj, 2, LOW.bitrateBps, VANILLA);
    expect(sLow).toBeGreaterThan(sHigh);
  });

  it('charges the switch penalty when previous bitrate differs', () => {
    const traj = trajectory(50_000_000, defaultConfig.horizonGroups);
    const noSwitch = simulateAndScore(HIGH, traj, 10, HIGH.bitrateBps, VANILLA);
    const withSwitch = simulateAndScore(HIGH, traj, 10, LOW.bitrateBps, VANILLA);
    expect(noSwitch).toBeGreaterThan(withSwitch);
  });

  it('a stall in step 1 is more painful than the same throughput with a large initial buffer', () => {
    const traj = trajectory(100_000, defaultConfig.horizonGroups);
    const emptyBuffer = simulateAndScore(HIGH, traj, 0, HIGH.bitrateBps, VANILLA);
    const largeBuffer = simulateAndScore(HIGH, traj, 60, HIGH.bitrateBps, VANILLA);
    expect(largeBuffer).toBeGreaterThan(emptyBuffer);
  });

  it('transport-cancellation: cancelled groups award no bitrate reward', () => {
    // 5 Mbps track at 200 kbps throughput: 50 s download per 2 s group, way
    // over the τ + buffer + ε deadline. Cancellation should drop reward to a
    // pure stall-equivalent penalty.
    const traj = trajectory(200_000, defaultConfig.horizonGroups);
    const cfgOn = { ...defaultConfig, transportCancelEpsilonSec: 0.5 };
    const cfgOff = { ...defaultConfig, transportCancelEpsilonSec: null };
    const withCancel = simulateAndScore(HIGH, traj, 0, HIGH.bitrateBps, cfgOn);
    const withoutCancel = simulateAndScore(HIGH, traj, 0, HIGH.bitrateBps, cfgOff);
    // Without cancellation, score is dominated by huge per-group stall.
    // With cancellation, penalty is capped at beta * τ per group.
    expect(withCancel).toBeGreaterThan(withoutCancel);
    // And the cancelled-group score equals exactly -beta * τ * horizon.
    const expected =
      -defaultConfig.qoeStallWeight * defaultConfig.groupDurationSec * defaultConfig.horizonGroups;
    expect(withCancel).toBeCloseTo(expected, 6);
  });

  it('transport-cancellation: does not trigger when buffer absorbs the download', () => {
    // 1 s of download against 5 s of buffer, well under τ + B + ε.
    const traj = trajectory(10_000_000, defaultConfig.horizonGroups);
    const cfgOn = { ...defaultConfig, transportCancelEpsilonSec: 0.5 };
    const cfgOff = { ...defaultConfig, transportCancelEpsilonSec: null };
    const on = simulateAndScore(HIGH, traj, 5, HIGH.bitrateBps, cfgOn);
    const off = simulateAndScore(HIGH, traj, 5, HIGH.bitrateBps, cfgOff);
    expect(on).toBeCloseTo(off, 9);
  });
});

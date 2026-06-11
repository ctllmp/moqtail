/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { AbrController } from '../src/lib/abr/controller';
import { BolaMoQ } from '../src/lib/abr/bola';
import { McTsAbr } from '../src/lib/abr/mcts';
import type { Abr, AbrConfig, AbrDecision, TrackCandidate } from '../src/lib/abr/types';
import { defaultConfig } from '../src/lib/abr/types';
import type { Trace } from './traces';

/** Paper's bitrate ladder: 300 / 750 / 1850 / 4300 / 8000 kbps. */
export const LADDER: TrackCandidate[] = [
  { name: 't300', bitrateBps: 300_000, width: 426, height: 240 },
  { name: 't750', bitrateBps: 750_000, width: 640, height: 360 },
  { name: 't1850', bitrateBps: 1_850_000, width: 1280, height: 720 },
  { name: 't4300', bitrateBps: 4_300_000, width: 1920, height: 1080 },
  { name: 't8000', bitrateBps: 8_000_000, width: 2560, height: 1440 },
];

const OBJECTS_PER_GROUP = 30;

export interface RunResult {
  algo: string;
  trace: string;
  /** Regime tag carried from the source Trace: stable / variable / adversarial. */
  traceKind: 'stable' | 'variable' | 'adversarial';
  meanQoE: number;
  totalStallSec: number;
  p95StallSec: number;
  meanBitrateMbps: number;
  switches: number;
  meanLatencyMs: number;
  p99LatencyMs: number;
  /** Mean absolute % error of filterMeanBps vs observed throughput (PF only). */
  filterMape: number;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * QoE accounting shared by every algorithm. Mirrors the buffer/stall recurrence
 * in qoe.ts so realized QoE uses the same model the controller optimizes.
 */
class PlaybackAccounting {
  bufferSec = 0;
  qoeSum = 0;
  bitrateSum = 0;
  groups = 0;
  readonly stalls: number[] = [];
  #prevMbps = 0;

  constructor(private readonly cfg: AbrConfig) {}

  /** Plays one group of `track` under `tputBps`; returns its download time (s). */
  step(track: TrackCandidate, tputBps: number): number {
    const cfg = this.cfg;
    const downloadSec = (track.bitrateBps * cfg.groupDurationSec) / Math.max(1, tputBps);
    const epsilon = cfg.transportCancelEpsilonSec;
    if (epsilon != null && downloadSec > cfg.groupDurationSec + this.bufferSec + epsilon) {
      // Relay cancels: no media delivered, one group worth of loss.
      this.qoeSum -= cfg.qoeStallWeight * cfg.groupDurationSec;
      this.bufferSec = Math.max(0, this.bufferSec - cfg.groupDurationSec);
      this.stalls.push(cfg.groupDurationSec);
      this.bitrateSum += 0;
      this.groups++;
      return downloadSec;
    }
    const stallSec = Math.max(0, downloadSec - this.bufferSec);
    this.bufferSec = Math.max(0, this.bufferSec - downloadSec) + cfg.groupDurationSec;
    this.stalls.push(stallSec);

    const bMbps = track.bitrateBps * 1e-6;
    this.qoeSum +=
      cfg.qoeBitrateWeight * bMbps -
      cfg.qoeStallWeight * stallSec -
      cfg.qoeSwitchWeight * Math.abs(bMbps - this.#prevMbps);
    this.#prevMbps = bMbps;
    this.bitrateSum += bMbps;
    this.groups++;
    return downloadSec;
  }
}

/** Emit OBJECTS_PER_GROUP objects spaced so the collector measures exactly tputBps. */
function feedGroup(
  ctrl: Abr,
  track: TrackCandidate,
  groupId: bigint,
  tputBps: number,
  cfg: AbrConfig,
  clockMs: number,
): number {
  const groupBytes = (track.bitrateBps * cfg.groupDurationSec) / 8;
  const downloadMs = (groupBytes * 8 * 1000) / Math.max(1, tputBps);
  const perObjBytes = groupBytes / OBJECTS_PER_GROUP;
  const perObjDeltaMs = downloadMs / OBJECTS_PER_GROUP;
  let t = clockMs;
  for (let j = 0; j < OBJECTS_PER_GROUP; j++) {
    t += perObjDeltaMs;
    ctrl.onObjectMeasured({
      trackName: track.name,
      groupId,
      objectId: BigInt(j),
      sizeBytes: perObjBytes,
      arrivalTimeMs: t,
    });
  }
  return t;
}

function summarize(
  algo: string,
  trace: Trace,
  acc: PlaybackAccounting,
  decisions: AbrDecision[],
  filterMape: number,
): RunResult {
  const latencies = decisions.map(d => d.decisionLatencyMs);
  const switches = decisions.filter(
    d => d.reason === 'switch_up' || d.reason === 'switch_down',
  ).length;
  return {
    algo,
    trace: trace.name,
    traceKind: trace.kind,
    meanQoE: acc.qoeSum / acc.groups,
    totalStallSec: acc.stalls.reduce((a, b) => a + b, 0),
    p95StallSec: percentile(acc.stalls, 95),
    meanBitrateMbps: acc.bitrateSum / acc.groups,
    switches,
    meanLatencyMs: latencies.length
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0,
    p99LatencyMs: percentile(latencies, 99),
    filterMape,
  };
}

/**
 * Drive an arbitrary {@link Abr} implementation against a trace. Shared loop
 * for runPfAbr / runBola / runMcts — only the constructor differs.
 */
function runAbrAgainst(
  trace: Trace,
  cfg: AbrConfig,
  label: string,
  make: (opts: ConstructorOpts) => Abr,
): RunResult {
  const acc = new PlaybackAccounting(cfg);
  let currentName = LADDER[0].name;
  const decisions: AbrDecision[] = [];
  const ctrl = make({
    config: cfg,
    candidates: LADDER,
    initialTrack: currentName,
    getBufferedSeconds: () => acc.bufferSec,
    switchTrack: next => {
      currentName = next;
    },
    onDecision: d => decisions.push(d),
  });

  let clockMs = 0;
  let absErrSum = 0;
  let absErrCount = 0;

  for (let g = 0; g < trace.bps.length; g++) {
    const track = LADDER.find(c => c.name === ctrl.getCurrentTrack().name)!;
    const tput = trace.bps[g];
    acc.step(track, tput);
    clockMs = feedGroup(ctrl, track, BigInt(g), tput, cfg, clockMs);
    ctrl.onEndOfGroup(track.name, BigInt(g));

    const last = decisions[decisions.length - 1];
    if (last && last.filterMeanBps > 0) {
      absErrSum += Math.abs(last.filterMeanBps - tput) / tput;
      absErrCount++;
    }
  }
  void currentName;
  const mape = absErrCount ? (100 * absErrSum) / absErrCount : 0;
  return summarize(label, trace, acc, decisions, mape);
}

interface ConstructorOpts {
  config: AbrConfig;
  candidates: TrackCandidate[];
  initialTrack: string;
  getBufferedSeconds: () => number;
  switchTrack: (next: string) => void;
  onDecision: (d: AbrDecision) => void;
}

export function runPfAbr(
  trace: Trace,
  cfg: AbrConfig = defaultConfig,
  label = 'PF-ABR',
): RunResult {
  return runAbrAgainst(trace, cfg, label, opts => new AbrController(opts));
}

export function runBolaMoQ(
  trace: Trace,
  cfg: AbrConfig = defaultConfig,
  label = 'BOLA-MoQ',
): RunResult {
  return runAbrAgainst(trace, cfg, label, opts => new BolaMoQ(opts));
}

export function runMcTsAbr(
  trace: Trace,
  cfg: AbrConfig = defaultConfig,
  label = 'MCTS-MoQ',
): RunResult {
  return runAbrAgainst(trace, cfg, label, opts => new McTsAbr(opts));
}

/**
 * Point-estimate baseline: harmonic-mean throughput over a sliding window with a
 * safety factor, picks the highest bitrate at/below the estimate, same hysteresis
 * window as PF-ABR. Stands in for the paper's "w/o particle filter" ablation.
 */
export function runBaseline(
  trace: Trace,
  cfg: AbrConfig = defaultConfig,
  label = 'Baseline',
): RunResult {
  const acc = new PlaybackAccounting(cfg);
  const sorted = [...LADDER].sort((a, b) => a.bitrateBps - b.bitrateBps);
  let current = sorted[0];
  const decisions: AbrDecision[] = [];
  const window: number[] = [];
  const WINDOW = 5;
  const SAFETY = 0.9;
  let groupsSinceSwitch = cfg.minGroupsBetweenSwitches;

  for (let g = 0; g < trace.bps.length; g++) {
    const tput = trace.bps[g];
    acc.step(current, tput);

    window.push(tput);
    if (window.length > WINDOW) window.shift();
    const harmonic = window.length / window.reduce((a, b) => a + 1 / Math.max(1, b), 0);
    const budget = harmonic * SAFETY;

    const t0 = performance.now();
    let target = sorted[0];
    for (const c of sorted) if (c.bitrateBps <= budget) target = c;
    const t1 = performance.now();

    const canSwitch = groupsSinceSwitch >= cfg.minGroupsBetweenSwitches;
    const wantsSwitch = target.name !== current.name;
    const reason: AbrDecision['reason'] = !wantsSwitch
      ? 'no_change'
      : !canSwitch
        ? 'hysteresis'
        : target.bitrateBps > current.bitrateBps
          ? 'switch_up'
          : 'switch_down';

    decisions.push({
      fromTrack: current.name,
      toTrack: reason === 'switch_up' || reason === 'switch_down' ? target.name : current.name,
      reason,
      expectedQoE: 0,
      perTrackExpectedQoE: {},
      observedThroughputBps: tput,
      filterMeanBps: harmonic,
      bufferSec: acc.bufferSec,
      decisionLatencyMs: t1 - t0,
      timestampMs: t1,
      groupId: BigInt(g),
    });

    if (reason === 'switch_up' || reason === 'switch_down') {
      current = target;
      groupsSinceSwitch = 0;
    } else {
      groupsSinceSwitch++;
    }
  }

  return summarize(label, trace, acc, decisions, 0);
}

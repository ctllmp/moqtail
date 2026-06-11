/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { MeasurementCollector } from './collector';
import { mulberry32, gaussian, type Prng } from './prng';
import { simulateOneGroup } from './qoe';
import type { Abr, AbrConfig, AbrDecision, ObjectMeasurement, TrackCandidate } from './types';

export interface McTsAbrOptions {
  config: AbrConfig;
  candidates: TrackCandidate[];
  initialTrack: string;
  getBufferedSeconds: () => number;
  switchTrack: (next: string) => void;
  onDecision?: (d: AbrDecision) => void;
  now?: () => number;
  /** Number of MCTS iterations per decision. Default 100. */
  iterations?: number;
  /** Sliding window of recent group throughputs used to seed rollouts. Default 30. */
  windowGroups?: number;
  /** UCB1 exploration constant. Default √2. */
  explorationC?: number;
  /** Multiplicative log-normal noise σ added to each bootstrapped throughput. Default 0.1. */
  rolloutNoiseSigma?: number;
}

/**
 * One node of the MCTS search tree. The tree branches on candidate-track
 * actions; each node represents a (depth, action-so-far) class. Because
 * throughput is stochastic, we don't store explicit state per node — every
 * iteration recomputes state by sampling throughputs along the descent path.
 */
class TreeNode {
  visits = 0;
  totalReward = 0;
  readonly children = new Map<string, TreeNode>();

  ucb1(parentVisits: number, c: number): number {
    if (this.visits === 0) return Infinity;
    return this.totalReward / this.visits + c * Math.sqrt(Math.log(parentVisits) / this.visits);
  }
  mean(): number {
    return this.visits === 0 ? 0 : this.totalReward / this.visits;
  }
}

/**
 * MCTS-MoQ: full multi-ply Monte Carlo Tree Search over the next `H` group
 * decisions. Each iteration performs:
 *   1. **Selection**: descend from root using UCB1, simulating one group per
 *      edge with a throughput drawn from the empirical-bootstrap window.
 *   2. **Expansion**: if the current node has no children, add one child for
 *      each candidate track. Continue descent into one of them.
 *   3. **Rollout**: once we descend through a previously-unvisited child,
 *      switch to a random-action policy for the remaining depth.
 *   4. **Backpropagation**: add the iteration's cumulative reward to every
 *      node on the path.
 *
 * After `iterations` runs, the root's children carry per-action visit counts
 * and mean rewards. The action with the highest mean is taken.
 *
 * Compared to a single-ply UCB1 bandit, the tree concentrates simulation
 * budget on promising *sequences* — at depth d, exploration is conditioned on
 * the actions chosen at depths 0..d-1. This is the standard MCTS formulation
 * (Browne et al. 2012) applied to ABR over MoQ.
 */
export class McTsAbr implements Abr {
  readonly #cfg: AbrConfig;
  readonly #candidates: TrackCandidate[];
  readonly #getBufferedSeconds: () => number;
  readonly #switchTrack: (next: string) => void;
  readonly #onDecision?: (d: AbrDecision) => void;
  readonly #now: () => number;
  readonly #collector = new MeasurementCollector();
  readonly #decisions: AbrDecision[] = [];
  readonly #rng: Prng;
  readonly #iterations: number;
  readonly #windowGroups: number;
  readonly #explorationC: number;
  readonly #rolloutSigma: number;
  readonly #window: number[] = [];

  #currentTrack: TrackCandidate;
  #groupsSinceSwitch: number;
  #disposed = false;

  constructor(opts: McTsAbrOptions) {
    if (opts.candidates.length === 0) {
      throw new Error('McTsAbr requires at least one video candidate');
    }
    const current = opts.candidates.find(c => c.name === opts.initialTrack);
    if (!current) throw new Error(`Initial track "${opts.initialTrack}" not in candidate list`);

    this.#cfg = opts.config;
    this.#candidates = [...opts.candidates].sort((a, b) => a.bitrateBps - b.bitrateBps);
    this.#currentTrack = current;
    this.#getBufferedSeconds = opts.getBufferedSeconds;
    this.#switchTrack = opts.switchTrack;
    this.#onDecision = opts.onDecision;
    this.#now = opts.now ?? (() => performance.now());
    this.#rng = mulberry32(this.#cfg.prngSeed);
    this.#iterations = Math.max(opts.candidates.length, opts.iterations ?? 100);
    this.#windowGroups = Math.max(1, opts.windowGroups ?? 30);
    this.#explorationC = opts.explorationC ?? Math.SQRT2;
    this.#rolloutSigma = opts.rolloutNoiseSigma ?? 0.1;
    this.#groupsSinceSwitch = this.#cfg.minGroupsBetweenSwitches;
  }

  onObjectMeasured(m: ObjectMeasurement): void {
    if (this.#disposed) return;
    this.#collector.ingestObject(m);
  }

  onEndOfGroup(trackName: string, groupId: bigint): void {
    if (this.#disposed) return;
    if (trackName !== this.#currentTrack.name) return;
    const group = this.#collector.finalizeGroup(trackName, groupId);
    if (!group) return;

    this.#window.push(group.throughputBps);
    if (this.#window.length > this.#windowGroups) this.#window.shift();
    if (this.#window.length === 0) return;

    const buffer = this.#getBufferedSeconds();
    const prevBps = this.#currentTrack.bitrateBps;

    const t0 = this.#now();
    const root = new TreeNode();
    for (let i = 0; i < this.#iterations; i++) {
      this.#iterate(root, buffer, prevBps);
    }
    const perTrack: Record<string, number> = {};
    let target = this.#candidates[0];
    let bestMean = -Infinity;
    for (const c of this.#candidates) {
      const child = root.children.get(c.name);
      const mean = child ? child.mean() : -Infinity;
      perTrack[c.name] = child ? mean : 0;
      if (mean > bestMean) {
        bestMean = mean;
        target = c;
      }
    }
    const t1 = this.#now();

    const canSwitch = this.#groupsSinceSwitch >= this.#cfg.minGroupsBetweenSwitches;
    const wantsSwitch = target.name !== this.#currentTrack.name;
    const reason: AbrDecision['reason'] = !wantsSwitch
      ? 'no_change'
      : !canSwitch
        ? 'hysteresis'
        : target.bitrateBps > this.#currentTrack.bitrateBps
          ? 'switch_up'
          : 'switch_down';

    const decision: AbrDecision = {
      fromTrack: this.#currentTrack.name,
      toTrack:
        reason === 'switch_up' || reason === 'switch_down' ? target.name : this.#currentTrack.name,
      reason,
      expectedQoE: bestMean,
      perTrackExpectedQoE: perTrack,
      observedThroughputBps: group.throughputBps,
      filterMeanBps: this.#windowHarmonicMean(),
      bufferSec: buffer,
      decisionLatencyMs: t1 - t0,
      timestampMs: t1,
      groupId,
    };
    this.#decisions.push(decision);
    this.#onDecision?.(decision);

    if (reason === 'switch_up' || reason === 'switch_down') {
      const from = this.#currentTrack;
      this.#currentTrack = target;
      this.#groupsSinceSwitch = 0;
      this.#collector.resetTrack(from.name);
      this.#switchTrack(target.name);
    } else {
      this.#groupsSinceSwitch++;
    }
  }

  getCurrentTrack(): TrackCandidate {
    return this.#currentTrack;
  }
  getDecisions(): readonly AbrDecision[] {
    return this.#decisions;
  }
  dispose(): void {
    this.#disposed = true;
    this.#collector.reset();
  }

  /** One MCTS iteration: select+expand → rollout → backprop. */
  #iterate(root: TreeNode, initialBuffer: number, initialPrevBps: number): void {
    const path: TreeNode[] = [root];
    let buffer = initialBuffer;
    let prevBps = initialPrevBps;
    let cumulativeReward = 0;
    let depth = 0;
    let node = root;
    let inTree = true;
    // Rollout policy: stick with the last action chosen inside the tree. This
    // makes the rollout evaluate "switch to X and hold" rather than "switch to
    // X then drift randomly" — the random policy would otherwise contaminate
    // the value estimate with spurious switch penalties at depths > tree depth.
    let lastActionName = this.#currentTrack.name;

    while (depth < this.#cfg.horizonGroups) {
      let pickedName: string;
      if (inTree) {
        if (node.children.size === 0) {
          for (const c of this.#candidates) node.children.set(c.name, new TreeNode());
        }
        let bestUcb = -Infinity;
        pickedName = this.#candidates[0].name;
        for (const [name, child] of node.children) {
          const ucb = child.ucb1(node.visits, this.#explorationC);
          if (ucb > bestUcb) {
            bestUcb = ucb;
            pickedName = name;
          }
        }
      } else {
        pickedName = lastActionName;
      }
      lastActionName = pickedName;
      const track = this.#candidates.find(c => c.name === pickedName)!;
      const tput = this.#sampleThroughput();
      const r = simulateOneGroup(track, tput, buffer, prevBps, this.#cfg);
      cumulativeReward += r.reward;
      buffer = r.bufferSec;
      prevBps = r.prevBitrateBps;

      if (inTree) {
        const child = node.children.get(pickedName)!;
        path.push(child);
        const wasUnvisited = child.visits === 0;
        node = child;
        if (wasUnvisited) inTree = false;
      }
      depth++;
    }

    for (const n of path) {
      n.visits++;
      n.totalReward += cumulativeReward;
    }
  }

  /** Empirical-bootstrap sample with multiplicative log-normal noise. */
  #sampleThroughput(): number {
    const base = this.#window[Math.floor(this.#rng() * this.#window.length)];
    const noise = gaussian(this.#rng, 0, this.#rolloutSigma);
    return Math.max(1, base * Math.exp(noise));
  }

  #windowHarmonicMean(): number {
    if (this.#window.length === 0) return 0;
    let s = 0;
    for (const v of this.#window) s += 1 / Math.max(1, v);
    return this.#window.length / s;
  }
}

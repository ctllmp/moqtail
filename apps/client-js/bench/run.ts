/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, type AbrConfig } from '../src/lib/abr/types';
import { coefficientOfVariation, defaultTraces } from './traces';
import { loadTracesFromDir } from './trace-loader';
import {
  LADDER,
  runBaseline,
  runBolaMoQ,
  runMcTsAbr,
  runPfAbr,
  type RunResult,
} from './simulate';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');

function toCsv(rows: RunResult[]): string {
  const header = [
    'algo',
    'trace',
    'meanQoE',
    'totalStallSec',
    'p95StallSec',
    'meanBitrateMbps',
    'switches',
    'meanLatencyMs',
    'p99LatencyMs',
    'filterMape',
  ];
  const lines = rows.map(r =>
    [
      r.algo,
      r.trace,
      r.meanQoE.toFixed(4),
      r.totalStallSec.toFixed(3),
      r.p95StallSec.toFixed(3),
      r.meanBitrateMbps.toFixed(3),
      r.switches,
      r.meanLatencyMs.toFixed(4),
      r.p99LatencyMs.toFixed(4),
      r.filterMape.toFixed(2),
    ].join(','),
  );
  return [header.join(','), ...lines].join('\n') + '\n';
}

function round(rows: RunResult[]): Record<string, unknown>[] {
  return rows.map(r => ({
    algo: r.algo,
    trace: r.trace,
    QoE: +r.meanQoE.toFixed(3),
    stall_s: +r.totalStallSec.toFixed(2),
    p95_stall: +r.p95StallSec.toFixed(2),
    Mbps: +r.meanBitrateMbps.toFixed(2),
    sw: r.switches,
    lat_ms: +r.meanLatencyMs.toFixed(3),
    p99_ms: +r.p99LatencyMs.toFixed(3),
    mape: +r.filterMape.toFixed(1),
  }));
}

interface Variant {
  label: string;
  cfg: AbrConfig;
  kind: 'pf' | 'baseline' | 'bola' | 'mcts';
}

function variants(): Variant[] {
  const base = defaultConfig;
  // Four algorithm families on the new defaults, plus a "PF/legacy" row that
  // shows what the controller looked like before the §4.4 cancellation + keep
  // -filter changes — useful as an ablation reference in the paper.
  return [
    { label: 'Baseline', cfg: base, kind: 'baseline' },
    { label: 'BOLA-MoQ', cfg: base, kind: 'bola' },
    { label: 'MCTS-MoQ', cfg: base, kind: 'mcts' },
    { label: 'PF-ABR', cfg: base, kind: 'pf' },
    {
      label: 'PF-ABR/legacy',
      cfg: { ...base, resetFilterOnSwitch: true, transportCancelEpsilonSec: null },
      kind: 'pf',
    },
  ];
}

/** PRNG seeds replicated per (variant, trace) for confidence intervals. */
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Welch's t-test for two independent samples; returns t, df, and a normal-CDF p. */
function welchTTest(a: number[], b: number[]): { t: number; df: number; p: number } {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 < 2 || n2 < 2) return { t: 0, df: 0, p: 1 };
  const m1 = a.reduce((s, v) => s + v, 0) / n1;
  const m2 = b.reduce((s, v) => s + v, 0) / n2;
  const v1 = a.reduce((s, v) => s + (v - m1) ** 2, 0) / (n1 - 1);
  const v2 = b.reduce((s, v) => s + (v - m2) ** 2, 0) / (n2 - 1);
  const se = Math.sqrt(v1 / n1 + v2 / n2);
  const t = se === 0 ? 0 : (m1 - m2) / se;
  // Welch–Satterthwaite degrees of freedom.
  const df = se === 0 ? 0 : (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));
  // Normal-CDF approximation of the t-tail. For df > ~30 this is within ~1%.
  const p = 2 * (1 - normCdf(Math.abs(t)));
  return { t, df, p };
}

function normCdf(x: number): number {
  // Abramowitz–Stegun 7.1.26 approximation of erf, then 0.5*(1+erf(x/√2)).
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * z);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  // Real traces are loaded only if a directory is supplied via env var.
  const realRoot = process.env.BENCH_TRACES_DIR ?? '';
  const realTraces = realRoot
    ? [
        ...loadTracesFromDir(join(realRoot, 'hsdpa'), { resampleGroups: 120, minCoV: 0.1, limit: 12 }),
        ...loadTracesFromDir(join(realRoot, 'fcc'), { resampleGroups: 120, minCoV: 0.1, limit: 12 }),
      ]
    : [];
  if (realTraces.length > 0) console.log(`Loaded ${realTraces.length} real traces from ${realRoot}`);
  const traces = [...defaultTraces(120), ...realTraces];
  const vs = variants();

  // Each (variant × trace) is run with SEEDS.length different PRNG seeds so
  // we get a variance estimate per cell.
  console.log(
    `\n=== Algorithm variants on ${traces.length} traces × ${SEEDS.length} seeds (${traces.length * vs.length * SEEDS.length} runs total) ===`,
  );
  const compareRows: RunResult[] = [];
  for (const tr of traces) {
    for (const v of vs) {
      for (const seed of SEEDS) {
        const cfg = { ...v.cfg, prngSeed: seed };
        const r =
          v.kind === 'pf'
            ? runPfAbr(tr, cfg, v.label)
            : v.kind === 'bola'
              ? runBolaMoQ(tr, cfg, v.label)
              : v.kind === 'mcts'
                ? runMcTsAbr(tr, cfg, v.label)
                : runBaseline(tr, cfg, v.label);
        compareRows.push(r);
      }
    }
  }
  console.table(round(compareRows.slice(0, 40)));
  if (compareRows.length > 40) {
    console.log(`(showing first 40 of ${compareRows.length} rows; full table in CSV)`);
  }

  // --- 1b. Aggregate per variant -------------------------------------------
  console.log('\n=== Aggregate per variant (mean across all traces) ===');
  const summary = vs.map(v => {
    const rs = compareRows.filter(r => r.algo === v.label);
    return {
      variant: v.label,
      mean_QoE: +avg(rs.map(r => r.meanQoE)).toFixed(3),
      total_stall_s: +sum(rs.map(r => r.totalStallSec)).toFixed(1),
      mean_bitrate_Mbps: +avg(rs.map(r => r.meanBitrateMbps)).toFixed(2),
      mean_switches: +avg(rs.map(r => r.switches)).toFixed(1),
      mean_lat_ms: +avg(rs.map(r => r.meanLatencyMs)).toFixed(3),
      mean_mape: +avg(rs.map(r => r.filterMape)).toFixed(1),
    };
  });
  console.table(summary);

  // --- 1c. Headline deltas vs baseline -------------------------------------
  const baseRow = summary.find(s => s.variant === 'Baseline')!;
  console.log('\n=== Headline: variants vs baseline ===');
  console.table(
    summary
      .filter(s => s.variant !== 'Baseline')
      .map(s => ({
        variant: s.variant,
        QoE_delta: pct(s.mean_QoE, baseRow.mean_QoE),
        stall_delta: pct(s.total_stall_s, baseRow.total_stall_s),
      })),
  );

  // --- 1d. Statistical significance (Welch's t-test vs Baseline) -----------
  // Per variant, pool QoE across (trace × seed) and run a Welch t-test against
  // Baseline's pool. With |traces|·|seeds| samples per group the df is large
  // enough that the normal-CDF p-value approximation is accurate.
  const baselineQoE = compareRows.filter(r => r.algo === 'Baseline').map(r => r.meanQoE);
  console.log(`\n=== Welch t-test vs Baseline (n=${baselineQoE.length} samples per variant) ===`);
  const sigRows = vs
    .filter(v => v.label !== 'Baseline')
    .map(v => {
      const variantQoE = compareRows.filter(r => r.algo === v.label).map(r => r.meanQoE);
      const m1 = variantQoE.reduce((s, x) => s + x, 0) / variantQoE.length;
      const m2 = baselineQoE.reduce((s, x) => s + x, 0) / baselineQoE.length;
      const sd1 = Math.sqrt(
        variantQoE.reduce((s, x) => s + (x - m1) ** 2, 0) / Math.max(1, variantQoE.length - 1),
      );
      const stderr1 = sd1 / Math.sqrt(variantQoE.length);
      const { t, df, p } = welchTTest(variantQoE, baselineQoE);
      return {
        variant: v.label,
        mean_QoE: +m1.toFixed(3),
        sd: +sd1.toFixed(3),
        stderr: +stderr1.toFixed(3),
        delta_vs_base: +(m1 - m2).toFixed(3),
        t_stat: +t.toFixed(2),
        df: +df.toFixed(1),
        p_value: +p.toFixed(4),
        sig: p < 0.05 ? (m1 > m2 ? '✓ better' : '✗ worse') : 'n.s.',
      };
    });
  console.table(sigRows);

  // --- 1e. Per-trace-kind Welch t-tests vs Baseline ------------------------
  // The pooled t-test in 1d hides regime-specific behavior — MCTS may shine
  // on stable links and underperform on adversarial ones (or vice versa).
  // Split by trace.kind and re-run the comparison inside each subset.
  const kinds: Array<RunResult['traceKind']> = ['stable', 'variable', 'adversarial'];
  console.log('\n=== Per-regime Welch t-test vs Baseline ===');
  const perKindRows: Array<Record<string, unknown>> = [];
  for (const kind of kinds) {
    const baseSubset = compareRows.filter(r => r.algo === 'Baseline' && r.traceKind === kind);
    if (baseSubset.length === 0) continue;
    const baseQoE = baseSubset.map(r => r.meanQoE);
    for (const v of vs) {
      if (v.label === 'Baseline') continue;
      const subset = compareRows.filter(r => r.algo === v.label && r.traceKind === kind);
      if (subset.length === 0) continue;
      const qoe = subset.map(r => r.meanQoE);
      const m1 = qoe.reduce((s, x) => s + x, 0) / qoe.length;
      const m2 = baseQoE.reduce((s, x) => s + x, 0) / baseQoE.length;
      const { t, p } = welchTTest(qoe, baseQoE);
      perKindRows.push({
        kind,
        variant: v.label,
        n_variant: qoe.length,
        n_base: baseQoE.length,
        mean_QoE: +m1.toFixed(3),
        base_QoE: +m2.toFixed(3),
        delta: +(m1 - m2).toFixed(3),
        t_stat: +t.toFixed(2),
        p_value: +p.toFixed(4),
        sig: p < 0.05 ? (m1 > m2 ? '✓ better' : '✗ worse') : 'n.s.',
      });
    }
  }
  console.table(perKindRows);

  // --- 2. Filter convergence sanity (PF variants only) ---------------------
  console.log('\n=== Filter tracking error (mean abs % error vs true throughput) ===');
  console.table(
    compareRows
      .filter(r => r.algo !== 'Baseline')
      .map(r => ({ variant: r.algo, trace: r.trace, mape_pct: +r.filterMape.toFixed(1) })),
  );

  // --- 3. Trace CoV reference ----------------------------------------------
  console.log('\n=== Trace coefficient of variation (stable < 0.5 <= variable) ===');
  console.table(
    traces.map(t => ({ trace: t.name, kind: t.kind, CoV: +coefficientOfVariation(t.bps).toFixed(2) })),
  );

  // --- 4. Efficiency sweep: K (particles) x H (horizon) --------------------
  console.log('\n=== Efficiency sweep: decision latency vs particle count K ===');
  const sweepTrace = traces.find(t => t.name === 'adversarial-cellular')!;
  const sweepRows: { K: number; H: number; QoE: number; mean_ms: number; p99_ms: number }[] = [];
  for (const K of [10, 25, 50, 100, 200]) {
    for (const H of [5]) {
      const cfg: AbrConfig = { ...defaultConfig, numParticles: K, horizonGroups: H };
      const r = runPfAbr(sweepTrace, cfg);
      sweepRows.push({
        K,
        H,
        QoE: +r.meanQoE.toFixed(3),
        mean_ms: +r.meanLatencyMs.toFixed(3),
        p99_ms: +r.p99LatencyMs.toFixed(3),
      });
    }
  }
  console.table(sweepRows);

  console.log('\n=== Efficiency sweep: horizon H at K=50 ===');
  const horizonRows: { K: number; H: number; QoE: number; mean_ms: number }[] = [];
  for (const H of [1, 3, 5, 7, 10]) {
    const cfg: AbrConfig = { ...defaultConfig, numParticles: 50, horizonGroups: H };
    const r = runPfAbr(sweepTrace, cfg);
    horizonRows.push({ K: 50, H, QoE: +r.meanQoE.toFixed(3), mean_ms: +r.meanLatencyMs.toFixed(3) });
  }
  console.table(horizonRows);

  // --- 5. Write artifacts ---------------------------------------------------
  writeFileSync(join(OUT_DIR, 'comparison.csv'), toCsv(compareRows));
  writeFileSync(
    join(OUT_DIR, 'latency_sweep.csv'),
    'K,H,QoE,mean_ms,p99_ms\n' +
      sweepRows.map(r => `${r.K},${r.H},${r.QoE},${r.mean_ms},${r.p99_ms}`).join('\n') +
      '\n',
  );
  console.log(`\nLadder: ${LADDER.map(c => `${c.bitrateBps / 1000}k`).join(', ')}`);
  console.log(`CSV artifacts written to ${OUT_DIR}/`);
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
function pct(a: number, b: number): string {
  if (b === 0) return 'n/a';
  const d = (100 * (a - b)) / Math.abs(b);
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
}

main();

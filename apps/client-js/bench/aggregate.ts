/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CSV aggregator for live tc-based browser experiments.
 *
 * Usage:
 *   npm --prefix apps/client-js run abr:aggregate -- <csv-file>...
 *
 * Each input file is a decision-history CSV downloaded from the AbrPanel.
 * Filenames are expected to be `abr-<algo>-<timestamp>.csv` (the panel's
 * built-in download names them this way). Algorithm is parsed from the
 * filename so the script doesn't have to guess from the data.
 *
 * Output:
 *   - A console-friendly summary table (algorithm × {mean QoE, mean stall,
 *     mean bitrate, switches, mean / p99 decision latency, filter MAPE}).
 *   - An aggregated CSV written next to the inputs, suitable for copy-pasting
 *     into the paper or feeding into a plot script.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

interface DecisionRow {
  groupId: bigint;
  timestampMs: number;
  reason: string;
  fromTrack: string;
  toTrack: string;
  observedThroughputBps: number;
  filterMeanBps: number;
  bufferSec: number;
  expectedQoE: number;
  decisionLatencyMs: number;
}

interface FileSummary {
  algo: string;
  file: string;
  decisions: number;
  switches: number;
  meanObservedMbps: number;
  meanBitrateMbps: number;
  meanBufferSec: number;
  meanExpectedQoE: number;
  meanLatencyMs: number;
  p99LatencyMs: number;
  filterMape: number;
  durationSec: number;
}

function parseCsv(path: string): DecisionRow[] {
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  // Skip the aggregator's own output (or any other CSV without decision rows).
  // This prevents `~/Downloads/abr-*.csv` from matching abr-aggregate.csv.
  if (!headers.includes('groupId')) {
    console.warn(`[aggregate] skipping ${basename(path)} — not a decision-history CSV`);
    return [];
  }
  const idx = (name: string) => {
    const i = headers.indexOf(name);
    if (i === -1) throw new Error(`column "${name}" missing in ${path}`);
    return i;
  };
  const I = {
    groupId: idx('groupId'),
    timestampMs: idx('timestampMs'),
    reason: idx('reason'),
    fromTrack: idx('fromTrack'),
    toTrack: idx('toTrack'),
    observedThroughputBps: idx('observedThroughputBps'),
    filterMeanBps: idx('filterMeanBps'),
    bufferSec: idx('bufferSec'),
    expectedQoE: idx('expectedQoE'),
    decisionLatencyMs: idx('decisionLatencyMs'),
  };
  const rows: DecisionRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    rows.push({
      groupId: BigInt(cols[I.groupId]),
      timestampMs: Number(cols[I.timestampMs]),
      reason: cols[I.reason],
      fromTrack: cols[I.fromTrack],
      toTrack: cols[I.toTrack],
      observedThroughputBps: Number(cols[I.observedThroughputBps]),
      filterMeanBps: Number(cols[I.filterMeanBps]),
      bufferSec: Number(cols[I.bufferSec]),
      expectedQoE: Number(cols[I.expectedQoE]),
      decisionLatencyMs: Number(cols[I.decisionLatencyMs]),
    });
  }
  return rows;
}

function algoFromFilename(path: string): string {
  const b = basename(path);
  // Expected: abr-<algo>-<iso-stamp>.csv. Fall back to the filename stem.
  const m = b.match(/^abr-(pf|mcts|bola|th)-/);
  if (m) return m[1];
  // Legacy filename format used during earlier sessions:
  if (b.startsWith('pf-abr-decisions-')) return 'pf';
  return b.replace(/\.csv$/, '');
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(file: string, rows: DecisionRow[]): FileSummary {
  if (rows.length === 0) {
    return {
      algo: algoFromFilename(file),
      file: basename(file),
      decisions: 0,
      switches: 0,
      meanObservedMbps: 0,
      meanBitrateMbps: 0,
      meanBufferSec: 0,
      meanExpectedQoE: 0,
      meanLatencyMs: 0,
      p99LatencyMs: 0,
      filterMape: 0,
      durationSec: 0,
    };
  }
  let sumObs = 0;
  let sumBuf = 0;
  let sumQoE = 0;
  let sumLat = 0;
  let switches = 0;
  let mapeSum = 0;
  let mapeCount = 0;
  const latencies: number[] = [];
  const bitrates: number[] = [];
  for (const r of rows) {
    sumObs += r.observedThroughputBps;
    sumBuf += r.bufferSec;
    sumQoE += r.expectedQoE;
    sumLat += r.decisionLatencyMs;
    latencies.push(r.decisionLatencyMs);
    if (r.reason === 'switch_up' || r.reason === 'switch_down') switches++;
    if (r.filterMeanBps > 0 && r.observedThroughputBps > 0) {
      mapeSum += Math.abs(r.filterMeanBps - r.observedThroughputBps) / r.observedThroughputBps;
      mapeCount++;
    }
    // Use the `toTrack` field as the bitrate proxy — extract trailing digits.
    const m = r.toTrack.match(/(\d+)/);
    if (m) bitrates.push(Number(m[1]) / 1000); // mon-t1850 → 1.850 Mbps
  }
  const n = rows.length;
  const durationSec =
    rows.length > 1 ? (rows[rows.length - 1].timestampMs - rows[0].timestampMs) / 1000 : 0;
  return {
    algo: algoFromFilename(file),
    file: basename(file),
    decisions: n,
    switches,
    meanObservedMbps: sumObs / n / 1e6,
    meanBitrateMbps: bitrates.length ? bitrates.reduce((a, b) => a + b, 0) / bitrates.length : 0,
    meanBufferSec: sumBuf / n,
    meanExpectedQoE: sumQoE / n,
    meanLatencyMs: sumLat / n,
    p99LatencyMs: percentile(latencies, 99),
    filterMape: mapeCount ? (100 * mapeSum) / mapeCount : 0,
    durationSec,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: tsx bench/aggregate.ts <csv-file>...');
    process.exit(1);
  }
  const summaries: FileSummary[] = [];
  for (const f of args) {
    const rows = parseCsv(f);
    if (rows.length === 0) continue;
    summaries.push(summarize(f, rows));
  }
  if (summaries.length === 0) {
    console.error('[aggregate] no valid decision-history CSVs found');
    process.exit(1);
  }

  console.log('\n=== Per-file summary ===');
  console.table(
    summaries.map(s => ({
      algo: s.algo,
      file: s.file,
      decisions: s.decisions,
      duration_s: +s.durationSec.toFixed(1),
      mean_obs_Mbps: +s.meanObservedMbps.toFixed(2),
      mean_bitrate_Mbps: +s.meanBitrateMbps.toFixed(2),
      mean_buf_s: +s.meanBufferSec.toFixed(2),
      mean_expQoE: +s.meanExpectedQoE.toFixed(2),
      switches: s.switches,
      mean_lat_ms: +s.meanLatencyMs.toFixed(2),
      p99_lat_ms: +s.p99LatencyMs.toFixed(2),
      mape_pct: +s.filterMape.toFixed(1),
    })),
  );

  // Group by algorithm (multiple CSVs per algo are averaged).
  const byAlgo = new Map<string, FileSummary[]>();
  for (const s of summaries) {
    if (!byAlgo.has(s.algo)) byAlgo.set(s.algo, []);
    byAlgo.get(s.algo)!.push(s);
  }
  if (byAlgo.size > 1 || (byAlgo.size === 1 && [...byAlgo.values()][0].length > 1)) {
    console.log('\n=== Per-algorithm aggregate (mean across files) ===');
    console.table(
      [...byAlgo.entries()].map(([algo, runs]) => {
        const m = (sel: (s: FileSummary) => number) =>
          runs.reduce((a, s) => a + sel(s), 0) / runs.length;
        return {
          algo,
          runs: runs.length,
          mean_bitrate_Mbps: +m(s => s.meanBitrateMbps).toFixed(2),
          mean_buf_s: +m(s => s.meanBufferSec).toFixed(2),
          mean_expQoE: +m(s => s.meanExpectedQoE).toFixed(2),
          mean_switches: +m(s => s.switches).toFixed(1),
          mean_lat_ms: +m(s => s.meanLatencyMs).toFixed(2),
          mape_pct: +m(s => s.filterMape).toFixed(1),
        };
      }),
    );
  }

  // Aggregated CSV for plotting
  const outDir = dirname(args[0]);
  const out = join(outDir, 'abr-aggregate.csv');
  const header = [
    'algo',
    'file',
    'decisions',
    'duration_s',
    'mean_obs_Mbps',
    'mean_bitrate_Mbps',
    'mean_buf_s',
    'mean_expQoE',
    'switches',
    'mean_lat_ms',
    'p99_lat_ms',
    'filterMape_pct',
  ].join(',');
  const lines = summaries.map(s =>
    [
      s.algo,
      s.file,
      s.decisions,
      s.durationSec.toFixed(2),
      s.meanObservedMbps.toFixed(3),
      s.meanBitrateMbps.toFixed(3),
      s.meanBufferSec.toFixed(3),
      s.meanExpectedQoE.toFixed(4),
      s.switches,
      s.meanLatencyMs.toFixed(4),
      s.p99LatencyMs.toFixed(4),
      s.filterMape.toFixed(2),
    ].join(','),
  );
  writeFileSync(out, header + '\n' + lines.join('\n') + '\n');
  console.log(`\nAggregated CSV: ${out}`);
}

main();

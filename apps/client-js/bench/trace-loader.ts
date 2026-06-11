/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { coefficientOfVariation, type Trace } from './traces';

/**
 * Reads real network traces from a directory tree. Supports two formats found
 * in the FCC / HSDPA-Norway datasets:
 *
 *   1. `bps-per-line` — one throughput value per line, bits per second.
 *      Blank lines and `#`-prefixed comments are ignored.
 *
 *   2. `pensieve` — two whitespace-separated columns per line: `delta_ms bytes`
 *      (the format used by the Pensieve repo). Throughput is computed as
 *      `bytes * 8 * 1000 / delta_ms`.
 *
 * Each input file becomes one {@link Trace}. The trace name is the filename
 * (without extension), prefixed by `real-` so it sorts apart from synthetic
 * traces in the bench output.
 *
 * Trace selection / format is inferred from the file's content (peek at the
 * first non-comment line). The decision is logged so misclassification is
 * easy to spot in CI output.
 */
export interface LoadOptions {
  /** Down-sample to this many groups by averaging contiguous samples. Skipped if not set. */
  resampleGroups?: number;
  /** Skip files whose sampled CoV is below this (drop nearly-constant traces). */
  minCoV?: number;
  /** Hard cap on number of files loaded (random selection). 0 = no cap. */
  limit?: number;
  /** Kind tag attached to every loaded trace. Default 'variable'. */
  kindOverride?: Trace['kind'];
}

export function loadTracesFromDir(dir: string, opts: LoadOptions = {}): Trace[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files = entries
    .map(e => join(dir, e))
    .filter(p => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
  const traces: Trace[] = [];
  for (const f of files) {
    const t = parseFile(f, opts);
    if (!t) continue;
    if (opts.minCoV != null && coefficientOfVariation(t.bps) < opts.minCoV) continue;
    traces.push(t);
  }
  if (opts.limit && opts.limit > 0 && traces.length > opts.limit) {
    return traces.slice(0, opts.limit);
  }
  return traces;
}

function parseFile(path: string, opts: LoadOptions): Trace | null {
  const ext = extname(path).toLowerCase();
  if (ext === '.md' || ext === '.json') return null;
  const text = readFileSync(path, 'utf8');
  const raw = text
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('#'));
  if (raw.length === 0) return null;

  const firstCols = raw[0].split(/\s+/);
  let bps: number[];
  if (firstCols.length >= 2 && firstCols.every(c => /^[\d.+-]+$/.test(c))) {
    // pensieve format: delta_ms bytes
    bps = [];
    for (const line of raw) {
      const cols = line.split(/\s+/);
      const deltaMs = Number(cols[0]);
      const bytes = Number(cols[1]);
      if (!isFinite(deltaMs) || deltaMs <= 0 || !isFinite(bytes) || bytes <= 0) continue;
      bps.push((bytes * 8 * 1000) / deltaMs);
    }
  } else {
    bps = [];
    for (const line of raw) {
      const v = Number(line);
      if (!isFinite(v) || v <= 0) continue;
      bps.push(v);
    }
  }
  if (bps.length === 0) return null;

  if (opts.resampleGroups && opts.resampleGroups > 0 && opts.resampleGroups < bps.length) {
    bps = downsample(bps, opts.resampleGroups);
  }

  const name = 'real-' + basename(path, ext);
  return { name, bps, kind: opts.kindOverride ?? 'variable' };
}

/** Average contiguous chunks so the trace ends up `target` groups long. */
function downsample(values: number[], target: number): number[] {
  const out: number[] = new Array(target);
  const step = values.length / target;
  for (let i = 0; i < target; i++) {
    const lo = Math.floor(i * step);
    const hi = Math.min(values.length, Math.floor((i + 1) * step));
    let s = 0;
    let n = 0;
    for (let j = lo; j < hi; j++) {
      s += values[j];
      n++;
    }
    out[i] = n > 0 ? s / n : values[Math.min(lo, values.length - 1)];
  }
  return out;
}

/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import type { AbrDecision } from '@/lib/abr';

interface Props {
  algo?: 'pf' | 'th' | 'bola' | 'mcts' | null;
  lastDecision: AbrDecision | null;
  history: AbrDecision[];
  monitorActive?: boolean;
  onReset?: () => void;
}

const REASON_COLOR: Record<AbrDecision['reason'], string> = {
  switch_up: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  switch_down: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  hysteresis: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
  no_change: 'bg-neutral-700/40 text-neutral-300 border-neutral-600/30',
  initial: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
};

function fmtBps(bps: number): string {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} kbps`;
  return `${bps.toFixed(0)} bps`;
}

/** Builds a CSV blob from the decision history and triggers a browser download. */
function downloadDecisionsCsv(history: AbrDecision[], algo: string): void {
  if (history.length === 0) return;
  // Stable per-track column set: union of all candidate names seen so far.
  const trackNames = Array.from(
    new Set(history.flatMap(d => Object.keys(d.perTrackExpectedQoE))),
  ).sort();
  const header = [
    'groupId',
    'timestampMs',
    'reason',
    'fromTrack',
    'toTrack',
    'observedThroughputBps',
    'filterMeanBps',
    'bufferSec',
    'expectedQoE',
    'decisionLatencyMs',
    ...trackNames.map(n => `eqoe_${n}`),
  ];
  const rows = history.map(d =>
    [
      d.groupId.toString(),
      d.timestampMs.toFixed(3),
      d.reason,
      d.fromTrack,
      d.toTrack,
      d.observedThroughputBps.toFixed(0),
      d.filterMeanBps.toFixed(0),
      d.bufferSec.toFixed(3),
      d.expectedQoE.toFixed(4),
      d.decisionLatencyMs.toFixed(4),
      ...trackNames.map(n => {
        const v = d.perTrackExpectedQoE[n];
        return v === undefined ? '' : v.toFixed(4);
      }),
    ].join(','),
  );
  const csv = [header.join(','), ...rows].join('\n') + '\n';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `abr-${algo}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Inline SVG line chart: observed throughput (solid) vs filter mean (dashed). */
function ThroughputChart({
  history,
  showFilter = true,
}: {
  history: AbrDecision[];
  showFilter?: boolean;
}) {
  const W = 268;
  const H = 80;
  const PAD = 6;
  if (history.length < 2) {
    return (
      <div class="flex h-20 items-center justify-center rounded border border-white/5 text-xs text-neutral-500">
        Awaiting data…
      </div>
    );
  }
  const tail = history.slice(-30);
  const obs = tail.map(d => d.observedThroughputBps);
  const flt = tail.map(d => d.filterMeanBps);
  const all = showFilter ? [...obs, ...flt] : obs;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = Math.max(1, max - min);
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / Math.max(1, tail.length - 1);
  const y = (v: number) => H - PAD - ((v - min) / range) * (H - 2 * PAD);
  const path = (vs: number[]) => vs.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} class="block w-full" role="img" aria-label="throughput chart">
      <rect width={W} height={H} class="fill-white/3" rx={4} />
      <path d={path(obs)} class="fill-none stroke-sky-400" stroke-width={1.5} />
      {showFilter && (
        <path
          d={path(flt)}
          class="fill-none stroke-violet-400"
          stroke-width={1.5}
          stroke-dasharray="3 2"
        />
      )}
      <text x={PAD} y={12} class="fill-neutral-500 text-[9px]">
        max {fmtBps(max)}
      </text>
      <text x={PAD} y={H - 2} class="fill-neutral-500 text-[9px]">
        min {fmtBps(min)}
      </text>
    </svg>
  );
}

/** Horizontal bars of per-track expected QoE; highlights the chosen track. */
function PerTrackBars({ decision }: { decision: AbrDecision }) {
  const entries = Object.entries(decision.perTrackExpectedQoE);
  if (entries.length === 0) return null;
  const values = entries.map(([, v]) => v);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = Math.max(0.0001, max - min);
  const zeroFrac = (0 - min) / span;
  return (
    <div class="space-y-1">
      {entries.map(([name, v]) => {
        const isChosen = name === decision.toTrack;
        const frac = (v - min) / span;
        const left = Math.min(zeroFrac, frac) * 100;
        const width = Math.abs(frac - zeroFrac) * 100;
        const positive = v >= 0;
        return (
          <div class="flex items-center gap-2 text-[11px]">
            <span class={`w-16 truncate font-mono ${isChosen ? 'text-emerald-300' : 'text-neutral-300'}`}>
              {name}
            </span>
            <div class="relative h-3 flex-1 rounded bg-white/5">
              <div
                class={`absolute top-0 h-3 rounded ${positive ? 'bg-emerald-500/60' : 'bg-red-500/60'}`}
                style={{ left: `${left}%`, width: `${Math.max(0.5, width)}%` }}
              />
              <div class="absolute top-0 h-3 w-px bg-white/20" style={{ left: `${zeroFrac * 100}%` }} />
            </div>
            <span class="w-12 text-right font-mono tabular-nums text-neutral-400">
              {v.toFixed(2)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function AbrPanel({
  algo = 'pf',
  lastDecision,
  history,
  monitorActive = false,
  onReset,
}: Props) {
  const d = lastDecision;
  const recent = history.slice(-20);
  const meanLatency =
    recent.length === 0 ? 0 : recent.reduce((a, b) => a + b.decisionLatencyMs, 0) / recent.length;
  const switchCount = history.filter(
    h => h.reason === 'switch_up' || h.reason === 'switch_down',
  ).length;
  const filterErr =
    d && d.observedThroughputBps > 0
      ? Math.abs(d.filterMeanBps - d.observedThroughputBps) / d.observedThroughputBps
      : 0;

  return (
    <div class="space-y-3 border-t border-white/6 p-3">
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          {algo === 'th'
            ? 'Throughput ABR'
            : algo === 'bola'
              ? 'BOLA-MoQ'
              : algo === 'mcts'
                ? 'MCTS-MoQ'
                : 'PF-ABR'}
        </h3>
        <div class="flex items-center gap-1">
          {d && (
            <span
              class={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${REASON_COLOR[d.reason]}`}
            >
              {d.reason.replace('_', ' ')}
            </span>
          )}
          <button
            type="button"
            onClick={() => downloadDecisionsCsv(history, algo ?? 'pf')}
            disabled={history.length === 0}
            class="cursor-pointer rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-neutral-300 transition-colors hover:border-white/20 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            title="Download the in-memory decision history as CSV"
          >
            CSV ({history.length})
          </button>
          <button
            type="button"
            onClick={() => onReset?.()}
            disabled={!onReset || history.length === 0}
            class="cursor-pointer rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-neutral-300 transition-colors hover:border-white/20 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            title="Clear the panel's decision history (keeps playback running)"
          >
            Reset
          </button>
        </div>
      </div>

      {monitorActive && (
        <p class="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-amber-200">
          MONITOR MODE — hypothetical 5-tier ladder; player can't actually switch
          tracks. Throughput and buffer are live; bitrate/QoE numbers are
          counterfactual.
        </p>
      )}

      {!d ? (
        <p class="text-xs text-neutral-500">
          Waiting for first decision (after {`bootstrap`} groups)…
        </p>
      ) : (
        <>
          <div class="grid grid-cols-2 gap-2 text-[11px]">
            <Cell label="Current track" value={d.toTrack} mono />
            <Cell label="Group" value={String(d.groupId)} mono />
            <Cell label="Observed" value={fmtBps(d.observedThroughputBps)} />
            <Cell
              label="Filter mean"
              value={fmtBps(d.filterMeanBps)}
              hint={`err ${(filterErr * 100).toFixed(0)}%`}
            />
            <Cell label="Buffer" value={`${d.bufferSec.toFixed(2)} s`} />
            <Cell
              label="Decision"
              value={`${d.decisionLatencyMs.toFixed(2)} ms`}
              hint={`avg ${meanLatency.toFixed(2)}`}
            />
            <Cell label="Switches" value={String(switchCount)} />
            <Cell label="Expected QoE" value={d.expectedQoE.toFixed(2)} />
          </div>

          <div>
            <p class="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
              Throughput
              <span class="ml-2 text-sky-400">— observed</span>
              {algo !== 'bola' && (
                <span class="ml-2 text-violet-400">⁃⁃ filter</span>
              )}
            </p>
            <ThroughputChart history={history} showFilter={algo !== 'bola'} />
          </div>

          <div>
            <p class="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
              Per-track expected QoE
            </p>
            <PerTrackBars decision={d} />
          </div>
        </>
      )}
    </div>
  );
}

function Cell({
  label,
  value,
  hint,
  mono = false,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div class="rounded border border-white/5 bg-white/3 px-2 py-1.5">
      <p class="text-[10px] uppercase tracking-wide text-neutral-500">{label}</p>
      <p class={`text-xs ${mono ? 'font-mono' : ''} text-neutral-100 tabular-nums`}>{value}</p>
      {hint && <p class="text-[10px] text-neutral-500">{hint}</p>}
    </div>
  );
}

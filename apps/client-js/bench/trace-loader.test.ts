import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTracesFromDir } from './trace-loader';

function makeTempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'moqtail-bench-'));
  return root;
}

describe('loadTracesFromDir', () => {
  it('parses bps-per-line format', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'a.txt'), '# header\n3000000\n2000000\n4000000\n');
    const ts = loadTracesFromDir(dir);
    expect(ts.length).toBe(1);
    expect(ts[0].name).toBe('real-a');
    expect(ts[0].bps).toEqual([3_000_000, 2_000_000, 4_000_000]);
  });

  it('parses pensieve delta_ms / bytes format', () => {
    const dir = makeTempDir();
    // 1000 ms / 250000 bytes -> 2,000,000 bps; 500 ms / 250000 bytes -> 4,000,000 bps
    writeFileSync(join(dir, 'b.txt'), '1000  250000\n500  250000\n');
    const ts = loadTracesFromDir(dir);
    expect(ts.length).toBe(1);
    expect(ts[0].bps[0]).toBeCloseTo(2_000_000, -3);
    expect(ts[0].bps[1]).toBeCloseTo(4_000_000, -3);
  });

  it('skips traces below minCoV', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'flat.txt'), '1000000\n1000000\n1000000\n');
    writeFileSync(join(dir, 'noisy.txt'), '500000\n3000000\n900000\n2500000\n');
    const ts = loadTracesFromDir(dir, { minCoV: 0.1 });
    expect(ts.map(t => t.name).sort()).toEqual(['real-noisy']);
  });

  it('downsamples to a target length', () => {
    const dir = makeTempDir();
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) lines.push(String(1_000_000 + i * 10_000));
    writeFileSync(join(dir, 'long.txt'), lines.join('\n') + '\n');
    const ts = loadTracesFromDir(dir, { resampleGroups: 10 });
    expect(ts.length).toBe(1);
    expect(ts[0].bps.length).toBe(10);
  });

  it('returns empty when the directory does not exist', () => {
    const ts = loadTracesFromDir('/tmp/does-not-exist-x9k2f');
    expect(ts).toEqual([]);
  });
});

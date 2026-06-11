# Real network traces for the bench

Drop trace files into `hsdpa/` and `fcc/` then run:

```bash
BENCH_TRACES_DIR=$PWD/apps/client-js/bench/traces \
  npm --prefix apps/client-js run abr:bench
```

The bench produces synthetic results plus one row per real trace.

## Accepted formats

Each file = one trace. Blank lines and `#` comments are ignored.

**Format A — bps per line** (one throughput value per line, bits per second):
```
2500000
2750000
1900000
500000
```

**Format B — Pensieve `delta_ms bytes`** (two whitespace-separated columns):
```
1000  312500
1000  280000
500   25000
```
Throughput per row is `bytes · 8 · 1000 / delta_ms`. This is the format used by
the [Pensieve](https://github.com/hongzimao/pensieve) trace utilities.

The loader auto-detects which format you used from the first non-comment line.

## Where to get the datasets

- **HSDPA Norway** — Riiser et al. 2013, "Commute Path Bandwidth Traces from 3G
  Networks." Often distributed as logs already in the pensieve format. Mirror:
  http://home.ifi.uio.no/paalh/dataset/hsdpa-tcp-logs/

- **FCC MBA** — "Measuring Broadband America."
  https://www.fcc.gov/general/measuring-broadband-america
  The raw FCC data is large and needs preprocessing. A common preprocessed
  form is the pensieve `cooked_traces/` directory.

If you want to convert ad-hoc data, the simplest path is to dump a list of
`bps` values into a file and let the loader pick that up as Format A.

## Loader behavior

- Traces shorter than 2 samples are skipped.
- Traces with coefficient of variation below 0.1 are skipped (effectively
  constant — not useful for stress).
- Each trace is downsampled to 120 groups by averaging contiguous samples,
  so all bench runs are comparable.
- At most 12 files per directory are loaded (deterministic order).
- Trace names get a `real-` prefix in the output so they sort apart from
  synthetic ones.

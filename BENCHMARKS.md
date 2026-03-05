# Benchmarks

Circuit complexity benchmarks for the `aztec-state-migration` library,
measured via the `MinimalBenchmark` contract.

Each function isolates a single migration path with zero business logic.
Results are compared against `transfer_private_to_private` (1,386 KB ACIR)
from the token contract as a familiar reference point.

## What this measures

**ACIR bytecode size** is proportional to the number of gates in the proving circuit.
More gates = longer client-side proving time and higher memory usage.
This is the primary cost metric for private functions in Aztec.

This does **not** measure:
- L1 proof verification cost (constant per transaction, regardless of circuit size)
- Kernel circuit overhead (constant per private function call)
- Public function execution cost (runs on sequencer, not in the proof)

## Results

| Function | ACIR (KB) | vs `transfer` | Args (Fields) |
|---|---:|---:|---:|
| `bench_mode_a_1_note` | 503 | 0.36x | 172 |
| `bench_mode_a_2_notes` | 549 | 0.40x | 218 |
| `bench_mode_a_3_notes` | 595 | 0.43x | 264 |
| `bench_mode_a_lock_1_note` | 431 | 0.31x | 42 |
| `bench_mode_a_lock_2_notes` | 449 | 0.32x | 43 |
| `bench_mode_a_lock_3_notes` | 466 | 0.34x | 44 |
| `bench_mode_b_1_note` | 627 | 0.45x | 279 |
| `bench_mode_b_2_notes` | 739 | 0.53x | 371 |
| `bench_mode_b_public_owned` | 551 | 0.40x | 216 |
| `bench_mode_b_public_unowned` | 313 | 0.23x | 103 |

## Per-note marginal cost

The first note includes one-time setup costs (signature verification,
block header hashing, archive registry call). Additional notes are cheap.

| Operation | 1st note (incl. setup) | Each additional |
|---|---:|---:|
| Mode A lock | 431 KB | 18 KB |
| Mode A claim | 503 KB | 46 KB |
| Mode B claim (private note) | 627 KB | 112 KB |

## Nullifiers per operation

| Operation | Nullifiers |
|---|---|
| Mode A lock (`lock_state`) | 0 (creates note + event) |
| Mode A claim (`with_note`) | 1 per note |
| Mode B claim (`with_note`) | 1 per note |
| Mode B public state (`with_public_state`) | 1 per slot group |

---

*Generated with `nargo 1.0.0-beta.18`.*
*Run `yarn benchmark` to regenerate.*

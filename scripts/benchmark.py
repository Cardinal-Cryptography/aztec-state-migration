#!/usr/bin/env python3
"""
Benchmark script for aztec-state-migration library.

Compiles the MinimalBenchmark contract and extracts ACIR bytecode sizes
for each function, then generates BENCHMARKS.md.

Usage:
    python3 scripts/benchmark.py                # compile + generate
    python3 scripts/benchmark.py --skip-compile # use existing artifacts
"""

import argparse
import base64
import gzip
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NOIR_DIR = ROOT / "noir"
ARTIFACT = NOIR_DIR / "target" / "minimal_benchmark-MinimalBenchmark.json"
TOKEN_ARTIFACT = NOIR_DIR / "target" / "token_migration_app_v2-TokenMigrationAppV2.json"
OUTPUT = ROOT / "BENCHMARKS.md"

SKIP_FUNCTIONS = {"constructor", "process_message", "public_dispatch", "sync_state"}


def compile_benchmark():
    packages = ["minimal_benchmark", "token_migration_app_v2"]
    for pkg in packages:
        print(f"Compiling {pkg}...", file=sys.stderr)
        result = subprocess.run(
            ["nargo", "compile", "--force", "--package", pkg],
            cwd=NOIR_DIR,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            print(f"Compilation of {pkg} failed:\n{result.stderr}", file=sys.stderr)
            sys.exit(1)
    print("Compilation successful.", file=sys.stderr)


def get_acir_size(bytecode_b64: str) -> int:
    if not bytecode_b64:
        return 0
    raw = base64.b64decode(bytecode_b64)
    try:
        return len(gzip.decompress(raw))
    except Exception:
        return len(raw)


def count_fields(t: dict) -> int:
    kind = t.get("kind", "")
    if kind in ("field", "integer", "boolean"):
        return 1
    if kind == "array":
        return t.get("length", 0) * count_fields(t.get("type", {}))
    if kind == "struct":
        return sum(count_fields(f.get("type", {})) for f in t.get("fields", []))
    if kind == "string":
        return t.get("length", 0)
    if kind == "tuple":
        return sum(count_fields(f) for f in t.get("fields", []))
    return 1


def extract_functions(artifact_path: Path) -> list[dict]:
    with open(artifact_path) as f:
        data = json.load(f)

    results = []
    for fn in data.get("functions", []):
        name = fn["name"].replace("__aztec_nr_internals__", "")
        is_unconstrained = fn.get("is_unconstrained", True)
        acir_bytes = get_acir_size(fn.get("bytecode", ""))
        params = fn.get("abi", {}).get("parameters", [])
        total_args = sum(count_fields(p.get("type", {})) for p in params)

        results.append({
            "name": name,
            "unconstrained": is_unconstrained,
            "acir_bytes": acir_bytes,
            "total_args": total_args,
        })

    results.sort(key=lambda x: (x["unconstrained"], x["name"]))
    return results


def get_nargo_version() -> str:
    try:
        result = subprocess.run(
            ["nargo", "--version"], capture_output=True, text=True
        )
        for line in result.stdout.strip().splitlines():
            if line.startswith("nargo version"):
                return line.split("=")[1].strip()
    except Exception:
        pass
    return "unknown"


def get_reference_function(artifact_path: Path, func_name: str) -> dict | None:
    """Extract a single function's data from another contract artifact."""
    if not artifact_path.exists():
        return None
    try:
        with open(artifact_path) as f:
            data = json.load(f)
        for fn in data.get("functions", []):
            name = fn["name"].replace("__aztec_nr_internals__", "")
            if name == func_name and not fn.get("is_unconstrained", True):
                return {
                    "name": name,
                    "unconstrained": False,
                    "acir_bytes": get_acir_size(fn.get("bytecode", "")),
                    "total_args": sum(
                        count_fields(p.get("type", {}))
                        for p in fn.get("abi", {}).get("parameters", [])
                    ),
                }
    except Exception:
        pass
    return None


def generate_markdown(functions: list[dict], reference: dict | None = None) -> str:
    constrained = [
        f for f in functions
        if not f["unconstrained"]
        and f["name"] not in SKIP_FUNCTIONS
    ]

    if not reference:
        print("ERROR: reference function not found", file=sys.stderr)
        sys.exit(1)

    nargo_version = get_nargo_version()
    ref_kb = reference["acir_bytes"] / 1024

    lines = [
        "# Benchmarks",
        "",
        "Circuit complexity benchmarks for the `aztec-state-migration` library,",
        "measured via the `MinimalBenchmark` contract.",
        "",
        "Each function isolates a single migration path with zero business logic.",
        f"Results are compared against `transfer_private_to_private` ({ref_kb:,.0f} KB ACIR)",
        "from the token contract as a familiar reference point.",
        "",
        "## What this measures",
        "",
        "**ACIR bytecode size** is proportional to the number of gates in the proving circuit.",
        "More gates = longer client-side proving time and higher memory usage.",
        "This is the primary cost metric for private functions in Aztec.",
        "",
        "This does **not** measure:",
        "- L1 proof verification cost (constant per transaction, regardless of circuit size)",
        "- Kernel circuit overhead (constant per private function call)",
        "- Public function execution cost (runs on sequencer, not in the proof)",
        "",
        "## Results",
        "",
        "| Function | ACIR (KB) | vs `transfer` | Args (Fields) |",
        "|---|---:|---:|---:|",
    ]

    for f in constrained:
        acir_kb = f["acir_bytes"] / 1024
        ratio = f["acir_bytes"] / reference["acir_bytes"]
        lines.append(
            f"| `{f['name']}` | {acir_kb:,.0f} | {ratio:.2f}x | {f['total_args']} |"
        )

    # Per-note marginal costs
    def get(name):
        return next(f for f in functions if f["name"] == name)

    def kb(b):
        return f"{b / 1024:,.0f} KB"

    l1 = get("bench_mode_a_lock_1_note")
    l2 = get("bench_mode_a_lock_2_notes")
    a1 = get("bench_mode_a_1_note")
    a2 = get("bench_mode_a_2_notes")
    b1 = get("bench_mode_b_1_note")
    b2 = get("bench_mode_b_2_notes")

    lines += [
        "",
        "## Per-note marginal cost",
        "",
        "The first note includes one-time setup costs (signature verification,",
        "block header hashing, archive registry call). Additional notes are cheap.",
        "",
        "| Operation | 1st note (incl. setup) | Each additional |",
        "|---|---:|---:|",
        f"| Mode A lock | {kb(l1['acir_bytes'])} | {kb(l2['acir_bytes'] - l1['acir_bytes'])} |",
        f"| Mode A claim | {kb(a1['acir_bytes'])} | {kb(a2['acir_bytes'] - a1['acir_bytes'])} |",
        f"| Mode B claim (private note) | {kb(b1['acir_bytes'])} | {kb(b2['acir_bytes'] - b1['acir_bytes'])} |",
    ]

    lines += [
        "",
        "## Nullifiers per operation",
        "",
        "| Operation | Nullifiers |",
        "|---|---|",
        "| Mode A lock (`lock_state`) | 0 (creates note + event) |",
        "| Mode A claim (`with_note`) | 1 per note |",
        "| Mode B claim (`with_note`) | 1 per note |",
        "| Mode B public state (`with_public_state`) | 1 per slot group |",
        "",
        "---",
        "",
        f"*Generated with `nargo {nargo_version}`.*",
        "*Run `yarn benchmark` to regenerate.*",
        "",
    ]

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Generate migration library benchmarks")
    parser.add_argument(
        "--skip-compile", action="store_true", help="Skip compilation, use existing artifacts"
    )
    args = parser.parse_args()

    if not args.skip_compile:
        compile_benchmark()

    if not ARTIFACT.exists():
        print(f"Artifact not found: {ARTIFACT}", file=sys.stderr)
        print("Run without --skip-compile or compile first.", file=sys.stderr)
        sys.exit(1)

    functions = extract_functions(ARTIFACT)
    reference = get_reference_function(TOKEN_ARTIFACT, "transfer_private_to_private")
    md = generate_markdown(functions, reference)

    OUTPUT.write_text(md, encoding="utf-8")
    print(f"Wrote {OUTPUT}", file=sys.stderr)
    print(md)


if __name__ == "__main__":
    main()

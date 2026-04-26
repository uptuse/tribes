#!/usr/bin/env python3
"""Batch-test the DIG parser across every .dig file in tools/dis_work/.

Reports counts, success rate, and any structural anomalies.
"""
import sys, traceback
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from dig_parse import build_geometry, parse_dig

ROOT = Path(__file__).parent / 'dis_work'
files = sorted(ROOT.glob('*.dig'))
print(f"Found {len(files)} .dig files")

ok = 0
fail = 0
warn = 0
fail_examples = []
for f in files:
    try:
        info = parse_dig(f)
        consumed = info['consumed']
        total = info['total']
        # +8 for highestMip + flags fields = total
        diff = total - consumed
        if diff < 0 or diff > 16:
            warn += 1
            if warn <= 5:
                print(f"  WARN: {f.name}: consumed={consumed}/{total} (diff={diff})")
        # Try to build geometry
        g = build_geometry(f)
        if g['n_tris'] == 0:
            warn += 1
            if warn <= 5:
                print(f"  WARN: {f.name}: 0 triangles")
        ok += 1
    except Exception as e:
        fail += 1
        if fail <= 5:
            fail_examples.append((f.name, str(e)))

print(f"\nResults: ok={ok}, fail={fail}, warn={warn}, total={len(files)}")
if fail_examples:
    print("\nFailures:")
    for name, err in fail_examples:
        print(f"  {name}: {err}")

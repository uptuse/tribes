#!/usr/bin/env python3
"""
Locate the .dis files referenced by Raindance.canonical.json across all
VOL archives in assets/tribes_original/base/.

The MIS file references shapes like "betower2.0.dis" but the VOL archive
actually stores "betower2.dis" — the ".0"/".1" suffix in the MIS is the
state index that the engine appends at runtime (see DIS Index spec:
the .dis file enumerates States, each with a stateNameIdx). So we strip
the trailing ".N" before searching.
"""
import json
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).parent.parent
CANON = REPO / 'assets/maps/raindance/canonical.json'
VOL_DIR = REPO / 'assets/tribes_original/base'


def collect_referenced_files(canonical):
    files = set()
    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k.lower() in ('filename', 'file', 'interiorfile', 'dis'):
                    if isinstance(v, str):
                        files.add(v.lower())
                walk(v)
        elif isinstance(o, list):
            for x in o:
                walk(x)
    walk(canonical)
    return files


def index_vols():
    """Returns dict mapping lowercase filename -> [list of vols containing it]."""
    index = {}
    for vol in sorted(VOL_DIR.glob('*.vol')):
        out = subprocess.run(
            ['python3', str(REPO / 'tools/vol_extract.py'), 'list', str(vol)],
            capture_output=True, text=True
        ).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 3 and not line.startswith('#'):
                name = parts[-1].lower()
                index.setdefault(name, []).append(vol.name)
    return index


def normalize_state_suffix(name: str) -> str:
    """betower2.0.dis -> betower2.dis"""
    return re.sub(r'\.(\d+)\.dis$', '.dis', name)


def main():
    canonical = json.loads(CANON.read_text())
    files = collect_referenced_files(canonical)
    print(f'searching for {len(files)} unique files referenced by Raindance.MIS')

    index = index_vols()
    print(f'indexed {len(index)} files across all VOLs\n')

    found, missing = 0, []
    for f in sorted(files):
        normalized = normalize_state_suffix(f)
        # Try exact, then state-stripped, then base name
        for candidate in (f, normalized):
            if candidate in index:
                vols = index[candidate]
                print(f'  {f:30s} -> {candidate:30s} in {",".join(vols)}')
                found += 1
                break
        else:
            missing.append(f)

    print(f'\nfound {found}/{len(files)}, missing {len(missing)}')
    if missing:
        print(f'missing: {missing[:20]}')

    # For everything found, what's the union of VOLs we need?
    needed_vols = set()
    for f in files:
        norm = normalize_state_suffix(f)
        if norm in index:
            needed_vols.update(index[norm])
    print(f'\nVOLs needed: {sorted(needed_vols)}')


if __name__ == '__main__':
    main()

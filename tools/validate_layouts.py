#!/usr/bin/env python3
"""
validate_layouts.py — Verify building layout connectivity.
Run: python3 tools/validate_layouts.py

Checks:
  1. All piece IDs in layouts exist in catalog
  2. All internal openings have a matching neighbor face (within 0.5m)
  3. Reports unmatched openings as exterior faces (warnings, not errors)

Exit code 0 = pass, 1 = connectivity errors found.
"""

import json, math, sys, os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)

CATALOG_PATH = os.path.join(ROOT, 'assets/buildings/catalog.json')
LAYOUTS_PATH = os.path.join(ROOT, 'assets/buildings/layouts.json')

GRID = 4.0
FLOOR_H = 4.25
MATCH_TOLERANCE = 0.5  # meters

def rot_y(x, z, deg):
    rad = deg * math.pi / 180
    c, s = math.cos(rad), math.sin(rad)
    return (x * c + z * s, -x * s + z * c)

DIR_MAP = {'+x': (1, 0), '-x': (-1, 0), '+z': (0, 1), '-z': (0, -1)}
OPPOSITE = {'+x': '-x', '-x': '+x', '+z': '-z', '-z': '+z'}

def rotated_openings(openings, deg):
    result = []
    for op in openings:
        dx, dz = DIR_MAP[op]
        rdx, rdz = rot_y(dx, dz, deg)
        rdx, rdz = round(rdx), round(rdz)
        if rdx == 1: result.append('+x')
        elif rdx == -1: result.append('-x')
        elif rdz == 1: result.append('+z')
        elif rdz == -1: result.append('-z')
    return result

def face_pos(wx, wz, bounds, direction):
    if direction == '+x': return (wx + bounds[0]/2, wz)
    elif direction == '-x': return (wx - bounds[0]/2, wz)
    elif direction == '+z': return (wx, wz + bounds[2]/2)
    elif direction == '-z': return (wx, wz - bounds[2]/2)

def validate():
    with open(CATALOG_PATH) as f:
        catalog = json.load(f)
    with open(LAYOUTS_PATH) as f:
        layouts = json.load(f)

    errors = 0
    warnings = 0

    for bld in layouts['buildings']:
        bx, by, bz = bld['pos']
        brot = bld.get('rot', 0)
        bname = bld.get('name', 'unnamed')

        print(f"\n{'='*60}")
        print(f"Building: {bname} at ({bx}, {by}, {bz}), rot={brot}°")
        print(f"{'='*60}")

        # Check piece IDs exist
        pieces_data = []
        for i, piece in enumerate(bld['pieces']):
            pid = piece['id']
            if pid not in catalog['pieces']:
                print(f"  ❌ ERROR: piece[{i}] id '{pid}' not in catalog")
                errors += 1
                continue

            gx, gy, gz = piece['grid']
            prot = piece.get('rot', 0)
            lx, ly, lz = gx * GRID, gy * FLOOR_H, gz * GRID

            # Apply building rotation to local pos
            rlx, rlz = rot_y(lx, lz, brot)
            wx = bx + rlx
            wy = by + ly
            wz = bz + rlz

            pdef = catalog['pieces'][pid]
            bounds = pdef.get('bounds', [4, 4.25, 4])
            total_rot = (brot + prot) % 360
            ops = rotated_openings(pdef.get('openings', []), total_rot)

            pieces_data.append({
                'idx': i, 'id': pid,
                'wx': wx, 'wy': wy, 'wz': wz,
                'bounds': bounds, 'openings': ops,
                'grid': (gx, gy, gz), 'rot': prot
            })

        # Connectivity check
        internal_matches = 0
        unmatched_exterior = 0

        for p in pieces_data:
            for op in p['openings']:
                fx, fz = face_pos(p['wx'], p['wz'], p['bounds'], op)
                matched = False

                for q in pieces_data:
                    if p['idx'] == q['idx']: continue
                    for qop in q['openings']:
                        if qop != OPPOSITE[op]: continue
                        qfx, qfz = face_pos(q['wx'], q['wz'], q['bounds'], qop)
                        dist = math.sqrt((fx - qfx)**2 + (fz - qfz)**2)
                        if dist < MATCH_TOLERANCE:
                            matched = True
                            internal_matches += 1
                            break
                    if matched: break

                if not matched:
                    unmatched_exterior += 1

        connected_pairs = internal_matches // 2  # each pair counted twice
        print(f"  Pieces: {len(pieces_data)}")
        print(f"  Internal connections: {connected_pairs}")
        print(f"  Exterior openings: {unmatched_exterior}")

        # Verify the building is a connected graph
        if len(pieces_data) > 1:
            adj = {p['idx']: set() for p in pieces_data}
            for p in pieces_data:
                for op in p['openings']:
                    fx, fz = face_pos(p['wx'], p['wz'], p['bounds'], op)
                    for q in pieces_data:
                        if p['idx'] == q['idx']: continue
                        for qop in q['openings']:
                            if qop != OPPOSITE[op]: continue
                            qfx, qfz = face_pos(q['wx'], q['wz'], q['bounds'], qop)
                            if math.sqrt((fx-qfx)**2 + (fz-qfz)**2) < MATCH_TOLERANCE:
                                adj[p['idx']].add(q['idx'])

            # BFS from first piece
            visited = set()
            queue = [pieces_data[0]['idx']]
            visited.add(queue[0])
            while queue:
                curr = queue.pop(0)
                for nb in adj[curr]:
                    if nb not in visited:
                        visited.add(nb)
                        queue.append(nb)

            if len(visited) < len(pieces_data):
                disconnected = [p for p in pieces_data if p['idx'] not in visited]
                print(f"  ❌ ERROR: {len(disconnected)} DISCONNECTED piece(s):")
                for p in disconnected:
                    print(f"     - [{p['idx']}] {p['id']} at grid {p['grid']}")
                errors += len(disconnected)
            else:
                print(f"  ✅ All pieces reachable (connected graph)")

    print(f"\n{'='*60}")
    if errors:
        print(f"FAILED: {errors} error(s)")
        return 1
    else:
        print(f"PASSED ({warnings} warning(s))")
        return 0

if __name__ == '__main__':
    sys.exit(validate())

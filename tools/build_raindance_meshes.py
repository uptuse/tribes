#!/usr/bin/env python3
"""Build a single binary mesh blob containing every Raindance interior shape.

For each unique fileName in canonical.json's neutral_interior_shapes:
  1. Find the matching .dis file (highest-detail) in tools/dis_work/
  2. Parse the .dis to discover its highest-LOD .dig (typically -01.dig
     for 2-LOD shapes, or -03.dig for 4-LOD; we pick max minPixels)
  3. Run build_geometry on it -> positions[] + indices[]
  4. Emit a binary record into the blob

Blob format (little-endian):
    u32 magic 'RDMS'        (Raindance Mesh Set)
    u32 version = 1
    u32 num_meshes
    Mesh[num_meshes]:
        u8 name_len; char[name_len] name
        u32 num_verts; float[3 * num_verts] positions
        u32 num_indices; u32[num_indices] indices    (triangles)

Companion JSON sidecar lists material names (TODO) and bounds.
"""
import json, struct, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from dig_parse import build_geometry

ROOT = Path(__file__).parent.parent
DIS_DIR = ROOT / 'tools' / 'dis_work'
OUT_BLOB = ROOT / 'assets' / 'maps' / 'raindance' / 'raindance_meshes.bin'
OUT_INFO = ROOT / 'assets' / 'maps' / 'raindance' / 'raindance_meshes.json'
CANONICAL = ROOT / 'assets' / 'maps' / 'raindance' / 'canonical.json'


def parse_dis_index(dis_path: Path) -> str:
    """Return the highest-detail .dig filename referenced by a .dis index.

    The actual .dis structure (reverse-engineered):
        u32 magic 'ITRs'
        u32 chunkSize
        u32 numStates
        u32[numStates] stateNameIdx
        u32 numLods
        Lod[numLods]: u32 minPixels, u32 lightStateIdx, u32 geomNameIdx, u32 linkable
        ... (some additional fields, then name_blob_size, then name_blob of NUL-terminated names indexed by byte offset)

    Names are accessed by byte offset into the name blob (not by ordinal).
    The name blob starts at a known offset relative to the file - empirically
    it begins right after a u32 telling us the relative offset of the blob's
    end from itself (the chunkSize trailer).
    """
    data = dis_path.read_bytes()
    if data[:4] != b'ITRs':
        raise ValueError(f'{dis_path.name}: bad magic {data[:4]!r}')
    chunk_size = struct.unpack_from('<I', data, 4)[0]
    p = 8
    num_states = struct.unpack_from('<I', data, p)[0]; p += 4
    p += num_states * 4  # skip stateNameIdx
    num_lods = struct.unpack_from('<I', data, p)[0]; p += 4
    lods = []
    for _ in range(num_lods):
        min_pixels, light_idx, geom_idx, linkable = \
            struct.unpack_from('<4I', data, p)
        p += 16
        lods.append((min_pixels, light_idx, geom_idx, linkable))

    # Skip remaining header structure to reach name_blob:
    #   u32 default_minPixels
    #   u32 numLightStates
    #   u32[numLightStates] light_state_offsets
    #   u32 numMaterialLists
    #   u32[2 * numMaterialLists] dml_offsets
    p += 4  # default_minPixels
    num_light = struct.unpack_from('<I', data, p)[0]; p += 4
    p += num_light * 4
    num_matl = struct.unpack_from('<I', data, p)[0]; p += 4
    p += num_matl * 8
    name_blob_start = p
    name_blob = data[name_blob_start:]

    # Pick lod with highest minPixels (most detail)
    best = max(lods, key=lambda l: l[0])
    geom_idx = best[2]

    # geom_idx is a byte offset into name_blob (NOT into file)
    if geom_idx >= len(name_blob):
        raise ValueError(f'{dis_path.name}: geom_idx {geom_idx} past blob {len(name_blob)}')
    end = name_blob.find(b'\0', geom_idx)
    if end < 0:
        end = len(name_blob)
    name = name_blob[geom_idx:end].decode('latin-1', 'replace')
    if not name.lower().endswith('.dig'):
        raise ValueError(f'{dis_path.name}: resolved name {name!r} is not a .dig')
    return name


def find_dig_file(dig_name: str) -> Path | None:
    """Find a .dig file in tools/dis_work case-insensitively."""
    target = dig_name.lower()
    for f in DIS_DIR.glob('*.dig'):
        if f.name.lower() == target:
            return f
    return None


def main():
    canon = json.loads(CANONICAL.read_text())
    interior_shapes = canon.get('neutral_interior_shapes', [])
    seen_files = []
    for s in interior_shapes:
        fn = s['fileName']
        if fn not in seen_files:
            seen_files.append(fn)

    print(f"unique shape files: {len(seen_files)}")

    meshes = []
    info = []
    for fn in seen_files:
        # fn looks like 'expbridge.0.dis' - need to find the .dis file
        dis_path = None
        for f in DIS_DIR.glob('*.dis'):
            # canonical 'expbridge.0.dis' matches our extracted 'EXPBRIDGE.dis' (case-insensitive, drop the .0)
            base = fn.lower().rsplit('.dis', 1)[0]
            # base = 'expbridge.0' or 'cube.5' etc. The .0/.1/.2 are state suffixes; drop them.
            base = base.rsplit('.', 1)[0]
            if f.stem.lower() == base:
                dis_path = f
                break
        if not dis_path:
            print(f"  {fn}: NO .dis FILE FOUND")
            continue
        try:
            dig_name = parse_dis_index(dis_path)
        except Exception as e:
            print(f"  {fn}: dis parse failed: {e}")
            continue
        dig_path = find_dig_file(dig_name)
        if not dig_path:
            print(f"  {fn}: dig {dig_name!r} not found in dis_work")
            continue
        try:
            g = build_geometry(dig_path)
        except Exception as e:
            print(f"  {fn}: dig parse failed: {e}")
            continue
        # Compute bounds
        positions = g['positions']
        if not positions:
            print(f"  {fn}: empty geometry")
            continue
        xs = positions[0::3]; ys = positions[1::3]; zs = positions[2::3]
        bounds_min = [min(xs), min(ys), min(zs)]
        bounds_max = [max(xs), max(ys), max(zs)]
        meshes.append((fn, g))
        info.append({
            'fileName': fn,
            'dis_path': str(dis_path.relative_to(ROOT)),
            'dig_path': str(dig_path.relative_to(ROOT)),
            'n_verts': g['n_verts'],
            'n_tris': g['n_tris'],
            'bounds_min': bounds_min,
            'bounds_max': bounds_max,
        })
        print(f"  {fn}: {dig_name} -> {g['n_verts']} verts / {g['n_tris']} tris bounds {bounds_min} -> {bounds_max}")

    # Write blob
    out = bytearray()
    out += b'RDMS'
    out += struct.pack('<II', 1, len(meshes))
    for fn, g in meshes:
        name_bytes = fn.encode('utf-8')
        out += struct.pack('<B', len(name_bytes))
        out += name_bytes
        out += struct.pack('<I', g['n_verts'])
        out += struct.pack(f"<{len(g['positions'])}f", *g['positions'])
        out += struct.pack('<I', len(g['indices']))
        out += struct.pack(f"<{len(g['indices'])}I", *g['indices'])

    OUT_BLOB.write_bytes(out)
    OUT_INFO.write_text(json.dumps({'meshes': info}, indent=2))
    print(f"\nwrote {OUT_BLOB} ({len(out)} bytes)")
    print(f"wrote {OUT_INFO}")
    print(f"meshes: {len(meshes)}/{len(seen_files)}")


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Build a single binary mesh blob (v2) containing every Raindance interior shape.

For each unique fileName in canonical.json's neutral_interior_shapes:
  1. Find the matching .dis file to discover LOD→DIG mapping and DML name
  2. Parse the .dis to get highest-LOD .dig filename and associated .dml filename
  3. Parse the .dml to get ordered texture name list
  4. Run build_geometry on the .dig -> positions, uvs, indices, materials
  5. Emit a binary record into the blob

Blob format v2 (little-endian):
    u32 magic 'RDMS'        (Raindance Mesh Set)
    u32 version = 2
    u32 num_meshes
    Mesh[num_meshes]:
        u8 name_len; char[name_len] name
        u32 num_verts; float[3 * num_verts] positions
        u32 num_uvs; float[2 * num_uvs] uvs
        u32 num_indices; u32[num_indices] indices    (triangles)
        u32 num_tris; u8[num_tris] material_indices

Companion JSON sidecar lists material names, bounds, DML info.

Asset source directories (extracted from .vol archives):
  - human1DML.vol -> buildings (.dig, .dml, .dis)
  - lushDML.vol   -> rocks (.dig, .dml, .dis)
  - Raindance.vol -> mission-specific .dis files
"""
import json, struct, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from dig_parse import build_geometry
from dml_parse import parse_dml_names

ROOT = Path(__file__).parent.parent
OUT_BLOB = ROOT / 'assets' / 'maps' / 'raindance' / 'raindance_meshes.bin'
OUT_INFO = ROOT / 'assets' / 'maps' / 'raindance' / 'raindance_meshes.json'
CANONICAL = ROOT / 'assets' / 'maps' / 'raindance' / 'canonical.json'

# Asset directories (extracted from .vol)
ASSET_DIRS = [
    Path('/tmp/vol_extract/human1'),
    Path('/tmp/vol_extract/lush'),
    Path('/tmp/vol_extract/raindance'),
]


def _read_string(data: bytes, p: int):
    """Read uint16-prefixed string (same as DIG/DML format)."""
    length = struct.unpack_from('<H', data, p)[0]
    raw_len = length & 0x7FFF
    p += 2
    s = data[p:p + raw_len].decode('latin-1', 'replace')
    p += raw_len
    if p < len(data) and data[p] == 0:
        p += 1
    return s, p


def find_file(name: str, dirs=ASSET_DIRS) -> Path | None:
    """Find a file case-insensitively across asset directories."""
    target = name.lower()
    for d in dirs:
        if not d.exists():
            continue
        for f in d.iterdir():
            if f.name.lower() == target:
                return f
    return None


def parse_dis(dis_path: Path) -> dict:
    """Parse a .dis file to extract highest-LOD .dig and associated .dml.

    Layout (from Darkstar itrshape.h + itrshape.cpp):
        --- Persistent framework header ---
        u32 magic 'ITRs'
        u32 chunkSize
        u32 version              (written by Persistent framework, = 3)
        --- ITRShape::read payload ---
        u32 numStates
        State[numStates]:        { u32 nameIndex, u32 lodIndex, u32 numLODs } = 12 bytes each
        u32 numLods
        LOD[numLods]:            { u32 minPixels, u32 geomFileOffset, u32 lightStateIndex, u32 linkableFaces } = 16 bytes each
        u32 numLodLightStates
        LODLightState[n]:        { u32 lightFileOffset } = 4 bytes each
        i32 numLightStates
        u32[numLightStates]      lightStateNames
        u32 nameBufferSize
        char[nameBufferSize]     nameBuffer
        i32 materialListOffset   (byte offset into nameBuffer)
        bool linkedInterior      (4 bytes on disk due to struct alignment)
    """
    data = dis_path.read_bytes()
    if data[:4] != b'ITRs':
        raise ValueError(f'{dis_path.name}: bad magic {data[:4]!r}')

    chunk_size = struct.unpack_from('<I', data, 4)[0]
    p = 8
    version = struct.unpack_from('<I', data, p)[0]; p += 4

    # States — each has 3 fields (12 bytes)
    num_states = struct.unpack_from('<I', data, p)[0]; p += 4
    states = []
    for _ in range(num_states):
        name_idx, lod_idx, num_lods_in_state = struct.unpack_from('<3I', data, p); p += 12
        states.append((name_idx, lod_idx, num_lods_in_state))

    # LODs — each has 4 fields (16 bytes)
    num_lods = struct.unpack_from('<I', data, p)[0]; p += 4
    lods = []
    for _ in range(num_lods):
        min_pixels, geom_offset, light_state_idx, linkable = \
            struct.unpack_from('<4I', data, p); p += 16
        lods.append((min_pixels, geom_offset, light_state_idx, linkable))

    # LOD light states
    num_lod_light_states = struct.unpack_from('<I', data, p)[0]; p += 4
    p += num_lod_light_states * 4  # skip lightFileOffset entries

    # Light state names
    num_light_states = struct.unpack_from('<i', data, p)[0]; p += 4
    p += num_light_states * 4  # skip lightStateNames

    # Name buffer
    name_buf_size = struct.unpack_from('<I', data, p)[0]; p += 4
    name_buf = data[p:p + name_buf_size]; p += name_buf_size

    # Material list offset
    mat_list_offset = struct.unpack_from('<i', data, p)[0]; p += 4

    def _get_name(byte_idx):
        if byte_idx < 0 or byte_idx >= len(name_buf):
            return None
        end = name_buf.find(b'\0', byte_idx)
        if end < 0:
            end = len(name_buf)
        return name_buf[byte_idx:end].decode('latin-1', 'replace')

    # Best LOD: pick from state 0, highest minPixels
    dig_name = None
    if states and lods:
        state0 = states[0]
        state_lods = lods[state0[1]:state0[1] + state0[2]]
        if state_lods:
            best = max(state_lods, key=lambda l: l[0])
            dig_name = _get_name(best[1])  # geom_offset into name_buf

    # DML name from materialListOffset
    dml_name = _get_name(mat_list_offset)

    return dict(
        version=version,
        dig_name=dig_name,
        dml_name=dml_name,
        num_lods=num_lods,
        num_states=num_states,
    )


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
        # fn looks like 'expbridge.0.dis' — base name is before .0.dis
        base = fn.lower().rsplit('.dis', 1)[0]
        base = base.rsplit('.', 1)[0]  # drop .0/.1 state suffix

        # Try to find .dis in asset dirs (first try mission-specific, then generic)
        # Mission .dis files have state suffixes like 'esmall2.0.dis'
        dis_path = find_file(fn) or find_file(base + '.dis')
        if not dis_path:
            print(f"  {fn}: NO .dis FILE FOUND")
            continue

        try:
            dis_info = parse_dis(dis_path)
        except Exception as e:
            print(f"  {fn}: dis parse failed: {e}")
            continue

        dig_name = dis_info['dig_name']
        dml_name = dis_info['dml_name']

        if not dig_name or not dig_name.lower().endswith('.dig'):
            print(f"  {fn}: bad dig name {dig_name!r}")
            continue

        dig_path = find_file(dig_name)
        if not dig_path:
            print(f"  {fn}: dig {dig_name!r} not found")
            continue

        # Parse DML for texture names
        mat_names = []
        if dml_name:
            dml_path = find_file(dml_name)
            if dml_path:
                try:
                    mat_names = parse_dml_names(dml_path)
                except Exception as e:
                    print(f"  {fn}: dml parse failed: {e}")
            else:
                print(f"  {fn}: dml {dml_name!r} not found")

        try:
            g = build_geometry(dig_path)
        except Exception as e:
            print(f"  {fn}: dig parse failed: {e}")
            continue

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
            'dig_name': dig_name,
            'dml_name': dml_name or '',
            'materials': mat_names,
            'n_verts': g['n_verts'],
            'n_tris': g['n_tris'],
            'n_portals_skipped': g['n_portals_skipped'],
            'n_null_skipped': g['n_null_skipped'],
            'bounds_min': bounds_min,
            'bounds_max': bounds_max,
        })
        print(f"  {fn}: {dig_name} -> {g['n_verts']} verts / {g['n_tris']} tris "
              f"({len(mat_names)} mats, {g['n_portals_skipped']} portals, "
              f"{g['n_null_skipped']} null skipped)")

    # Write blob v2
    out = bytearray()
    out += b'RDMS'
    out += struct.pack('<II', 2, len(meshes))
    for fn, g in meshes:
        name_bytes = fn.encode('utf-8')
        out += struct.pack('<B', len(name_bytes))
        out += name_bytes
        # Positions
        out += struct.pack('<I', g['n_verts'])
        out += struct.pack(f"<{len(g['positions'])}f", *g['positions'])
        # UVs
        n_uvs = len(g['uvs']) // 2
        out += struct.pack('<I', n_uvs)
        out += struct.pack(f"<{len(g['uvs'])}f", *g['uvs'])
        # Indices
        out += struct.pack('<I', len(g['indices']))
        out += struct.pack(f"<{len(g['indices'])}I", *g['indices'])
        # Material indices (one u8 per triangle)
        n_tris = g['n_tris']
        out += struct.pack('<I', n_tris)
        out += struct.pack(f"<{n_tris}B", *g['materials_per_tri'])

    OUT_BLOB.parent.mkdir(parents=True, exist_ok=True)
    OUT_BLOB.write_bytes(out)
    OUT_INFO.write_text(json.dumps({'meshes': info}, indent=2))
    print(f"\nwrote {OUT_BLOB} ({len(out)} bytes)")
    print(f"wrote {OUT_INFO}")
    print(f"meshes: {len(meshes)}/{len(seen_files)}")


if __name__ == '__main__':
    main()

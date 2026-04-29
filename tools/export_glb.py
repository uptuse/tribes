#!/usr/bin/env python3
"""Export all Tribes 1 models to standard GLB files for Blender editing.

Two sources:
  1. Interior shapes from raindance_meshes.bin (buildings, rocks, pads)
  2. DTS models from assets/ directory (armor, weapons, tower)

Coordinate transform (applied during export):
  Tribes 1: Z-up, left-handed, CW winding
  GLB/Blender: Y-up, right-handed, CCW winding
  Transform: (x, y, z) -> (x, z, -y)  [Rx(-90°)]
  Winding:   (i, j, k) -> (i, k, j)   [CW -> CCW]

Output: assets/glb/<name>.glb for each model

DTS format documentation derived from jamesu's TribesViewer:
  https://github.com/jamesu/TribesViewer
"""
import struct, json, sys, os
import numpy as np
from pathlib import Path

from pygltflib import (
    GLTF2, Scene, Node, Mesh, Primitive, Accessor, BufferView, Buffer,
    Material as GLTFMaterial, PbrMetallicRoughness,
    FLOAT, UNSIGNED_INT, SCALAR, VEC2, VEC3, TRIANGLES,
    ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER,
)

ROOT = Path(__file__).parent.parent
BIN_PATH = ROOT / 'assets' / 'maps' / 'raindance' / 'raindance_meshes.bin'
JSON_PATH = ROOT / 'assets' / 'maps' / 'raindance' / 'raindance_meshes.json'
PALETTE_PATH = ROOT / 'assets' / 'maps' / 'raindance' / 'material_palette.json'
OUT_DIR = ROOT / 'assets' / 'glb'


# ─── Material palette ───────────────────────────────────────────────────────

def load_material_palette():
    if not PALETTE_PATH.exists():
        return {}
    with open(PALETTE_PATH) as f:
        return json.load(f)


# ─── Interior shapes from raindance_meshes.bin ──────────────────────────────

def read_raindance_meshes():
    """Read all meshes from raindance_meshes.bin v2 format."""
    data = BIN_PATH.read_bytes()
    p = 0
    magic = data[p:p+4]; p += 4
    assert magic == b'RDMS', f'Bad magic: {magic!r}'
    version = struct.unpack_from('<I', data, p)[0]; p += 4
    assert version == 2
    num_meshes = struct.unpack_from('<I', data, p)[0]; p += 4

    meshes = []
    for _ in range(num_meshes):
        name_len = data[p]; p += 1
        name = data[p:p+name_len].decode('ascii'); p += name_len

        nv = struct.unpack_from('<I', data, p)[0]; p += 4
        positions = np.array(struct.unpack_from(f'<{nv*3}f', data, p), dtype=np.float32).reshape(-1, 3)
        p += nv * 3 * 4

        nu = struct.unpack_from('<I', data, p)[0]; p += 4
        uvs = np.array(struct.unpack_from(f'<{nu*2}f', data, p), dtype=np.float32).reshape(-1, 2)
        p += nu * 2 * 4

        ni = struct.unpack_from('<I', data, p)[0]; p += 4
        indices = np.array(struct.unpack_from(f'<{ni}I', data, p), dtype=np.uint32)
        p += ni * 4

        nt = struct.unpack_from('<I', data, p)[0]; p += 4
        mat_indices = np.array(struct.unpack_from(f'<{nt}B', data, p), dtype=np.uint8)
        p += nt

        meshes.append({'name': name, 'positions': positions, 'uvs': uvs,
                       'indices': indices, 'mat_indices': mat_indices})
    return meshes


# ─── DTS (Darkstar Three-Space Shape) parser ────────────────────────────────
# Format from jamesu/TribesViewer main.cpp

def _read_pers_header(data, p):
    """Read PERS chunk header: tag, size, className. Returns (className, dataStart, chunkEnd)."""
    tag = data[p:p+4]; p += 4
    if tag != b'PERS':
        return None, p, p
    cs = struct.unpack_from('<I', data, p)[0] & 0x7FFFFFFF; p += 4
    chunk_end = p + cs  # chunkSize counts from after size field
    sl = struct.unpack_from('<H', data, p)[0]; p += 2
    rl = sl & 0x7FFF
    cn = data[p:p+rl].decode('latin-1', 'replace')
    p += rl
    if p < len(data) and data[p] == 0:
        p += 1
    return cn, p, chunk_end


def _parse_cel_anim_mesh(data, chunk_start):
    """Parse a TS::CelAnimMesh chunk. Returns (positions, tex_verts, faces, vertsPerFrame) or None.
    
    Layout (v3):
      version (i32)
      numVerts (i32) - total packed verts across all frames
      vertsPerFrame (i32)
      numTexVerts (i32)
      numFaces (i32)
      numFrames (i32)
      texVertsPerFrame (i32) [v2+]
      [scale (3f), origin (3f)] [v1 only]
      radius (f32)
      PackedVertex[numVerts]: x(u8), y(u8), z(u8), normal(u8)
      TexVert[numTexVerts]: u(f32), v(f32)
      Face[numFaces]: vi0(i32), ti0(i32), vi1(i32), ti1(i32), vi2(i32), ti2(i32), mat(i32)
      Frame[numFrames]: firstVert(i32), scale(3f), origin(3f) [v3]
                    OR  firstVert(i32) per frame [v1-2, using shared scale/origin]
    """
    cn, p, chunk_end = _read_pers_header(data, chunk_start)
    if cn != 'TS::CelAnimMesh':
        return None

    version = struct.unpack_from('<i', data, p)[0]; p += 4

    numVerts = struct.unpack_from('<i', data, p)[0]; p += 4
    vertsPerFrame = struct.unpack_from('<i', data, p)[0]; p += 4
    numTexVerts = struct.unpack_from('<i', data, p)[0]; p += 4
    numFaces = struct.unpack_from('<i', data, p)[0]; p += 4
    numFrames = struct.unpack_from('<i', data, p)[0]; p += 4

    if version >= 2:
        _texVertsPerFrame = struct.unpack_from('<i', data, p)[0]; p += 4

    v2scale = v2origin = None
    if version < 3:
        v2scale = struct.unpack_from('<3f', data, p); p += 12
        v2origin = struct.unpack_from('<3f', data, p); p += 12

    radius = struct.unpack_from('<f', data, p)[0]; p += 4

    # Sanity checks
    if numVerts <= 0 or numVerts > 500000 or vertsPerFrame <= 0 or vertsPerFrame > 500000:
        return None
    if numFaces < 0 or numFaces > 500000 or numTexVerts < 0 or numTexVerts > 500000:
        return None
    if numFrames <= 0 or numFrames > 10000:
        return None
    if p + numVerts * 4 > len(data):
        return None

    # PackedVertex: 4 bytes each
    packed = []
    for _ in range(numVerts):
        packed.append((data[p], data[p+1], data[p+2], data[p+3]))
        p += 4

    # Texture verts
    tex_verts = []
    for _ in range(numTexVerts):
        u, v = struct.unpack_from('<2f', data, p)
        tex_verts.append((u, v))
        p += 8

    # Faces: 7 int32 each
    faces = []
    for _ in range(numFaces):
        vi0, ti0, vi1, ti1, vi2, ti2, mat = struct.unpack_from('<7i', data, p)
        faces.append((vi0, ti0, vi1, ti1, vi2, ti2, mat))
        p += 28

    # Frames
    frames = []
    if version < 3:
        for _ in range(numFrames):
            fv = struct.unpack_from('<i', data, p)[0]; p += 4
            frames.append({'firstVert': fv, 'scale': v2scale, 'origin': v2origin})
    else:
        for _ in range(numFrames):
            fv = struct.unpack_from('<i', data, p)[0]
            sc = struct.unpack_from('<3f', data, p+4)
            org = struct.unpack_from('<3f', data, p+16)
            frames.append({'firstVert': fv, 'scale': sc, 'origin': org})
            p += 28

    # Reconstruct frame 0 vertex positions
    frame0 = frames[0] if frames else {'firstVert': 0, 'scale': (1,1,1), 'origin': (0,0,0)}
    sc = frame0['scale']
    org = frame0['origin']
    first_v = frame0['firstVert']

    positions = np.zeros((vertsPerFrame, 3), dtype=np.float32)
    for i in range(vertsPerFrame):
        idx = first_v + i
        if idx >= len(packed):
            break
        pv = packed[idx]
        positions[i, 0] = org[0] + sc[0] * (pv[0] / 255.0)
        positions[i, 1] = org[1] + sc[1] * (pv[1] / 255.0)
        positions[i, 2] = org[2] + sc[2] * (pv[2] / 255.0)

    return positions, tex_verts, faces, vertsPerFrame


def parse_dts_shape(path):
    """Parse a Tribes 1 DTS file, extract and merge all CelAnimMesh sub-meshes."""
    data = path.read_bytes()

    all_positions = []
    all_uvs = []
    all_indices = []
    vertex_offset = 0

    # Scan for all TS::CelAnimMesh PERS chunks (byte-by-byte to find nested chunks)
    scan_p = 0
    while scan_p < len(data) - 8:
        if data[scan_p:scan_p+4] == b'PERS':
            cn, data_start, chunk_end = _read_pers_header(data, scan_p)
            if cn == 'TS::CelAnimMesh':
                result = _parse_cel_anim_mesh(data, scan_p)
                if result is not None:
                    positions, tex_verts, faces, vpf = result
                    if len(positions) > 0 and len(faces) > 0:
                        # Build UV array (one per vertex, from face tex indices)
                        uvs = np.zeros((len(positions), 2), dtype=np.float32)
                        for vi0, ti0, vi1, ti1, vi2, ti2, mat in faces:
                            if 0 <= vi0 < vpf and ti0 < len(tex_verts):
                                uvs[vi0] = tex_verts[ti0]
                            if 0 <= vi1 < vpf and ti1 < len(tex_verts):
                                uvs[vi1] = tex_verts[ti1]
                            if 0 <= vi2 < vpf and ti2 < len(tex_verts):
                                uvs[vi2] = tex_verts[ti2]

                        # Build index array
                        mesh_indices = []
                        for vi0, ti0, vi1, ti1, vi2, ti2, mat in faces:
                            if 0 <= vi0 < vpf and 0 <= vi1 < vpf and 0 <= vi2 < vpf:
                                mesh_indices.extend([
                                    vi0 + vertex_offset,
                                    vi1 + vertex_offset,
                                    vi2 + vertex_offset,
                                ])

                        all_positions.append(positions)
                        all_uvs.append(uvs)
                        all_indices.extend(mesh_indices)
                        vertex_offset += len(positions)

                # Skip past processed CelAnimMesh chunk
                if chunk_end > scan_p + 8:
                    scan_p = chunk_end
                else:
                    scan_p += 4
            else:
                # For non-CelAnimMesh PERS chunks (like TS::Shape), DON'T skip ahead—
                # they contain nested PERS chunks we need to find
                scan_p += 4
            continue
        scan_p += 1

    if not all_positions:
        raise ValueError(f'No mesh data found in {path.name}')

    positions = np.vstack(all_positions)
    uvs = np.vstack(all_uvs)
    indices = np.array(all_indices, dtype=np.uint32)

    return positions, uvs, indices


# ─── Coordinate transforms ──────────────────────────────────────────────────

def tribes_to_yup(positions):
    """Tribes Z-up LH → Y-up RH: (x,y,z) → (x,z,-y)"""
    out = np.empty_like(positions)
    out[:, 0] = positions[:, 0]
    out[:, 1] = positions[:, 2]
    out[:, 2] = -positions[:, 1]
    return out


def flip_winding(indices):
    """CW → CCW: swap 2nd and 3rd vertex of each triangle."""
    out = indices.copy()
    n = len(indices) // 3
    for t in range(n):
        b = t * 3
        out[b+1], out[b+2] = indices[b+2], indices[b+1]
    return out


def compute_normals(positions, indices):
    normals = np.zeros_like(positions)
    n = len(indices) // 3
    for t in range(n):
        i0, i1, i2 = indices[t*3], indices[t*3+1], indices[t*3+2]
        e1 = positions[i1] - positions[i0]
        e2 = positions[i2] - positions[i0]
        normal = np.cross(e1, e2)
        normals[i0] += normal
        normals[i1] += normal
        normals[i2] += normal
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    lengths[lengths < 1e-10] = 1.0
    return (normals / lengths).astype(np.float32)


# ─── GLB export ─────────────────────────────────────────────────────────────

def mesh_to_glb(name, positions, uvs, indices, mat_indices, mesh_info, palette):
    """Convert a single mesh to a GLB file with PBR materials."""
    positions = tribes_to_yup(positions)
    indices = flip_winding(indices)
    normals = compute_normals(positions, indices)

    material_names = mesh_info.get('materials', []) if mesh_info else []
    default_mat = palette.get('_default', {'color': [0.5, 0.5, 0.5], 'roughness': 0.7, 'metalness': 0.2})

    # Group triangles by material
    tri_groups = {}
    for t in range(len(indices) // 3):
        mi = int(mat_indices[t]) if t < len(mat_indices) else 0
        tri_groups.setdefault(mi, []).append(t)

    gltf = GLTF2()
    gltf.scenes = [Scene(nodes=[0])]
    gltf.scene = 0

    all_bin = bytearray()
    buffer_views = []
    accessors = []
    materials = []
    primitives = []

    # Create GLTF materials
    mat_idx_map = {}
    for mi in sorted(tri_groups.keys()):
        mat_name = material_names[mi].lower().replace('.bmp', '') if mi < len(material_names) else f'material_{mi}'
        pal_entry = None
        for pk, pv in palette.items():
            if pk.lower() == mat_name.lower():
                pal_entry = pv; break
        if pal_entry is None:
            base = mat_name.split('.')[0] if '.' in mat_name else mat_name
            for pk, pv in palette.items():
                if pk.lower() == base.lower():
                    pal_entry = pv; break
        if pal_entry is None:
            pal_entry = default_mat

        color = pal_entry.get('color', [0.5, 0.5, 0.5])
        gltf_mat = GLTFMaterial(
            name=mat_name,
            pbrMetallicRoughness=PbrMetallicRoughness(
                baseColorFactor=color + [1.0],
                metallicFactor=pal_entry.get('metalness', 0.2),
                roughnessFactor=pal_entry.get('roughness', 0.7),
            ),
            doubleSided=True,
        )
        mat_idx_map[mi] = len(materials)
        materials.append(gltf_mat)

    gltf.materials = materials

    # Position buffer
    pos_bytes = positions.astype(np.float32).tobytes()
    pos_bv = len(buffer_views)
    pos_off = len(all_bin); all_bin.extend(pos_bytes)
    while len(all_bin) % 4: all_bin.append(0)
    buffer_views.append(BufferView(buffer=0, byteOffset=pos_off, byteLength=len(pos_bytes), target=ARRAY_BUFFER))
    pos_acc = len(accessors)
    accessors.append(Accessor(bufferView=pos_bv, componentType=FLOAT, count=len(positions),
                              type=VEC3, max=positions.max(axis=0).tolist(), min=positions.min(axis=0).tolist()))

    # Normal buffer
    norm_bytes = normals.astype(np.float32).tobytes()
    norm_bv = len(buffer_views)
    norm_off = len(all_bin); all_bin.extend(norm_bytes)
    while len(all_bin) % 4: all_bin.append(0)
    buffer_views.append(BufferView(buffer=0, byteOffset=norm_off, byteLength=len(norm_bytes), target=ARRAY_BUFFER))
    norm_acc = len(accessors)
    accessors.append(Accessor(bufferView=norm_bv, componentType=FLOAT, count=len(normals), type=VEC3))

    # UV buffer
    uv_bytes = uvs.astype(np.float32).tobytes()
    uv_bv = len(buffer_views)
    uv_off = len(all_bin); all_bin.extend(uv_bytes)
    while len(all_bin) % 4: all_bin.append(0)
    buffer_views.append(BufferView(buffer=0, byteOffset=uv_off, byteLength=len(uv_bytes), target=ARRAY_BUFFER))
    uv_acc = len(accessors)
    accessors.append(Accessor(bufferView=uv_bv, componentType=FLOAT, count=len(uvs), type=VEC2))

    # Per-material index buffers
    for mi in sorted(tri_groups.keys()):
        tris = tri_groups[mi]
        gi = np.array([indices[t*3+j] for t in tris for j in range(3)], dtype=np.uint32)
        idx_bytes = gi.tobytes()
        idx_bv = len(buffer_views)
        idx_off = len(all_bin); all_bin.extend(idx_bytes)
        while len(all_bin) % 4: all_bin.append(0)
        buffer_views.append(BufferView(buffer=0, byteOffset=idx_off, byteLength=len(idx_bytes), target=ELEMENT_ARRAY_BUFFER))
        idx_acc = len(accessors)
        accessors.append(Accessor(bufferView=idx_bv, componentType=UNSIGNED_INT, count=len(gi), type=SCALAR))
        primitives.append(Primitive(
            attributes={'POSITION': pos_acc, 'NORMAL': norm_acc, 'TEXCOORD_0': uv_acc},
            indices=idx_acc, material=mat_idx_map[mi], mode=TRIANGLES))

    gltf.meshes = [Mesh(name=name, primitives=primitives)]
    gltf.nodes = [Node(name=name, mesh=0)]
    gltf.accessors = accessors
    gltf.bufferViews = buffer_views
    gltf.buffers = [Buffer(byteLength=len(all_bin))]
    gltf.set_binary_blob(bytes(all_bin))
    return gltf


# ─── Export pipelines ────────────────────────────────────────────────────────

def export_interior_shapes():
    """Export all interior shapes from raindance_meshes.bin."""
    if not BIN_PATH.exists():
        print(f'SKIP: {BIN_PATH} not found')
        return []

    meshes = read_raindance_meshes()
    palette = load_material_palette()

    mesh_info_map = {}
    if JSON_PATH.exists():
        with open(JSON_PATH) as f:
            for m in json.load(f).get('meshes', []):
                mesh_info_map[m['fileName']] = m

    exported = set()
    results = []

    for mesh in meshes:
        info = mesh_info_map.get(mesh['name'], {})
        dig_name = info.get('dig_name', mesh['name'])
        clean = dig_name.replace('.dig', '').replace('-00', '').lower()
        if clean in exported:
            continue
        exported.add(clean)

        try:
            gltf = mesh_to_glb(clean, mesh['positions'], mesh['uvs'],
                               mesh['indices'], mesh['mat_indices'], info, palette)
            out = OUT_DIR / f'{clean}.glb'
            gltf.save(str(out))
            results.append({'name': clean, 'source': mesh['name'], 'dig': dig_name,
                           'verts': len(mesh['positions']), 'tris': len(mesh['indices'])//3,
                           'materials': len(info.get('materials', [])),
                           'file': str(out.relative_to(ROOT)),
                           'size_kb': round(out.stat().st_size / 1024, 1), 'status': 'OK'})
            print(f'  ✓ {clean}.glb ({len(mesh["positions"])} verts, {len(mesh["indices"])//3} tris)')
        except Exception as e:
            results.append({'name': clean, 'source': mesh['name'], 'status': f'FAIL: {e}'})
            print(f'  ✗ {clean}: {e}')

    return results


def export_dts_models():
    """Export DTS models (armor, weapons, tower) to GLB."""
    dts_dir = ROOT / 'assets'
    dts_files = sorted(list(dts_dir.glob('*.DTS')) + list(dts_dir.glob('*.dts')))
    palette = load_material_palette()
    results = []

    for dts_path in dts_files:
        clean = dts_path.stem.lower()
        try:
            positions, uvs, indices = parse_dts_shape(dts_path)
            mat_indices = np.zeros(len(indices) // 3, dtype=np.uint8)

            gltf = mesh_to_glb(clean, positions, uvs, indices, mat_indices,
                               {'materials': ['default']}, palette)
            out = OUT_DIR / f'{clean}.glb'
            gltf.save(str(out))
            results.append({'name': clean, 'source': dts_path.name,
                           'verts': len(positions), 'tris': len(indices)//3,
                           'file': str(out.relative_to(ROOT)),
                           'size_kb': round(out.stat().st_size / 1024, 1), 'status': 'OK'})
            print(f'  ✓ {clean}.glb ({len(positions)} verts, {len(indices)//3} tris)')
        except Exception as e:
            results.append({'name': clean, 'source': dts_path.name, 'status': f'FAIL: {e}'})
            print(f'  ✗ {clean}: {e}')

    return results


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    all_results = []

    print('=== Exporting Interior Shapes (from raindance_meshes.bin) ===')
    all_results.extend(export_interior_shapes())

    print()
    print('=== Exporting DTS Models (armor, weapons, tower) ===')
    all_results.extend(export_dts_models())

    # Summary
    summary_path = OUT_DIR / 'export_summary.json'
    ok = sum(1 for r in all_results if r['status'] == 'OK')
    fail = sum(1 for r in all_results if r['status'] != 'OK')
    with open(summary_path, 'w') as f:
        json.dump({'total': len(all_results), 'ok': ok, 'failed': fail, 'models': all_results}, f, indent=2)

    print(f'\n=== Summary ===')
    print(f'  Exported: {ok}')
    print(f'  Failed:   {fail}')
    print(f'  Output:   {OUT_DIR}/')
    if fail:
        print('\n  Failures:')
        for r in all_results:
            if r['status'] != 'OK':
                print(f'    {r["name"]}: {r["status"]}')

    return 0 if fail == 0 else 1


if __name__ == '__main__':
    sys.exit(main())

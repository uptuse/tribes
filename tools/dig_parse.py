#!/usr/bin/env python3
"""Parse a Tribes 1 DIG (Interior Geometry) file into a JSON-friendly dict.

Per jamesu's format gist:

    Tag 'PERS'
    uint32 chunkSize
    String className 'ITRGeometry'        <- uint16 len + chars + dword pad
    int32 version
    int32 buildId
    float textureScale
    Point3F minBounds                      <- 3 floats
    Point3F maxBounds                      <- 3 floats
    int32 numSurfaces
    int32 numBSPNodes
    int32 numSolidLeafs
    int32 numEmptyLeafs
    int32 numPVSBits
    int32 numVerts
    int32 numPoint3Fs
    int32 numPoint2Fs
    int32 numPlanes
    Surface[numSurfaces]:
        u8 flags, u8 materials, u8 tsX, u8 tsY, u8 toX, u8 toY,
        u16 planeIdx, u32 vertIdx, u32 pointIdx, u8 numVerts, u8 numPoints
    BSPNode[numBSPNodes]
    BSPLeafSolid[numSolidLeafs]
    BSPLeafEmpty[numEmptyLeafs]
    u8[numPVSBits]
    Vertex[numVerts]: u16 pIdx, u16 tIdx
    Point3F[numPoint3Fs]
    Point2F[numPoint2Fs]
    Plane[numPlanes]
    int32 highestMip
    uint32 flags

For our renderer we need: minBounds, maxBounds, surfaces, vertices, points3F.
We collapse each surface (a polygon fan) into triangles and emit a
single-buffer mesh: positions[float32], indices[uint32], material[uint8].
"""
from __future__ import annotations
import struct, sys, json
from pathlib import Path
from typing import Tuple, List


def _read_string(data: bytes, p: int) -> Tuple[str, int]:
    """Read uint16-prefixed string. Empirically Tribes 1 strings include a
    trailing NUL terminator after the data (so on-disk size = length + 1)
    and the whole record (length + data + NUL) is dword-aligned."""
    start = p
    length = struct.unpack_from('<H', data, p)[0]
    raw_len = length & 0x7FFF
    p += 2
    s = data[p:p+raw_len].decode('latin-1', 'replace')
    p += raw_len
    # Always consume trailing NUL (Tribes 1 strings are NUL-terminated
    # in addition to the length prefix). No further dword padding.
    if p < len(data) and data[p] == 0:
        p += 1
    return s, p


def parse_dig(path: Path) -> dict:
    data = path.read_bytes()
    p = 0
    tag = data[p:p+4]; p += 4
    if tag != b'PERS':
        raise ValueError(f'unexpected tag {tag!r} at start')
    chunk_size = struct.unpack_from('<I', data, p)[0]; p += 4
    raw_chunk = chunk_size & 0x7FFFFFFF
    class_name, p = _read_string(data, p)
    if class_name != 'ITRGeometry':
        raise ValueError(f'unexpected className {class_name!r}')

    version = struct.unpack_from('<i', data, p)[0]; p += 4
    build_id = struct.unpack_from('<I', data, p)[0]; p += 4
    texture_scale = struct.unpack_from('<f', data, p)[0]; p += 4
    min_bounds = struct.unpack_from('<3f', data, p); p += 12
    max_bounds = struct.unpack_from('<3f', data, p); p += 12

    (n_surf, n_bsp, n_solid, n_empty, n_pvs, n_vert, n_p3, n_p2, n_plane) = \
        struct.unpack_from('<9i', data, p); p += 36

    # Spec field size sums to 18 bytes, but Tribes pads each surface to 20.
    SURF_STRIDE = 20
    surfaces = []
    for i in range(n_surf):
        flags, materials, tsx, tsy, tox, toy = struct.unpack_from('<6B', data, p)
        plane_idx = struct.unpack_from('<H', data, p+6)[0]
        vert_idx = struct.unpack_from('<I', data, p+8)[0]
        point_idx = struct.unpack_from('<I', data, p+12)[0]
        nv = data[p+16]; np_ = data[p+17]
        surfaces.append(dict(flags=flags, materials=materials,
                             tsX=tsx, tsY=tsy, toX=tox, toY=toy,
                             plane_idx=plane_idx, vert_idx=vert_idx,
                             point_idx=point_idx, num_verts=nv, num_points=np_))
        p += SURF_STRIDE

    p += n_bsp * 8                              # BSPNode: 8 bytes
    p += n_solid * 12                           # BSPLeafSolid: 12 bytes
    p += n_empty * 44                           # BSPLeafEmpty: 44 bytes (spec says 38, real layout pads to 44)
    p += n_pvs                                  # PVS bits

    # Vertices
    verts = []
    for i in range(n_vert):
        pIdx, tIdx = struct.unpack_from('<HH', data, p); p += 4
        verts.append((pIdx, tIdx))

    # Points3F
    pts3 = []
    for i in range(n_p3):
        x, y, z = struct.unpack_from('<3f', data, p); p += 12
        pts3.append((x, y, z))

    # Points2F
    pts2 = []
    for i in range(n_p2):
        u, v = struct.unpack_from('<2f', data, p); p += 8
        pts2.append((u, v))

    # Planes (16 bytes each)
    planes = []
    for i in range(n_plane):
        x, y, z, d = struct.unpack_from('<4f', data, p); p += 16
        planes.append((x, y, z, d))

    # tail
    highest_mip = None
    flags_field = None
    if p + 8 <= len(data):
        highest_mip = struct.unpack_from('<i', data, p)[0]; p += 4
        flags_field = struct.unpack_from('<I', data, p)[0]; p += 4

    return dict(
        version=version,
        build_id=build_id,
        texture_scale=texture_scale,
        min_bounds=list(min_bounds),
        max_bounds=list(max_bounds),
        n_surf=n_surf, n_bsp=n_bsp, n_solid=n_solid, n_empty=n_empty,
        n_pvs=n_pvs, n_vert=n_vert, n_p3=n_p3, n_p2=n_p2, n_plane=n_plane,
        surfaces_sample=surfaces[:5],
        n_surfaces_parsed=len(surfaces),
        verts_sample=verts[:5],
        pts3_sample=pts3[:5],
        consumed=p,
        total=len(data),
        highest_mip=highest_mip,
        flags_field=flags_field,
    )


def build_geometry(path: Path) -> dict:
    """Convert a DIG into a renderable {positions, indices, materials} dict.

    Each surface is a polygon fan: triangles (v0, v1, v2), (v0, v2, v3), ...
    """
    data = path.read_bytes()
    p = 0
    p += 4  # PERS
    p += 4  # chunkSize
    _, p = _read_string(data, p)
    p += 4 + 4 + 4  # version, buildId, textureScale
    p += 12 + 12    # bounds

    n_surf, n_bsp, n_solid, n_empty, n_pvs, n_vert, n_p3, n_p2, n_plane = \
        struct.unpack_from('<9i', data, p); p += 36

    surfs = []
    for _ in range(n_surf):
        flags, materials = data[p], data[p+1]
        plane_idx = struct.unpack_from('<H', data, p+6)[0]
        vert_idx = struct.unpack_from('<I', data, p+8)[0]
        nv = data[p+16]
        surfs.append((flags, materials, plane_idx, vert_idx, nv))
        p += 20  # 18 bytes content + 2 bytes pad
    p += n_bsp * 8 + n_solid * 12 + n_empty * 44 + n_pvs

    verts_pidx = []
    for _ in range(n_vert):
        pIdx = struct.unpack_from('<H', data, p)[0]; p += 4
        verts_pidx.append(pIdx)
    pts3 = []
    for _ in range(n_p3):
        pts3.append(struct.unpack_from('<3f', data, p))
        p += 12

    # Build positions + indices
    positions = []
    for x, y, z in pts3:
        positions.extend([x, y, z])

    indices = []
    materials_per_tri = []
    for flags, materials, plane_idx, vert_idx, nv in surfs:
        if nv < 3:
            continue
        # Polygon fan v0,v1,v2 / v0,v2,v3 / ...
        if vert_idx + nv > len(verts_pidx):
            continue
        v0 = verts_pidx[vert_idx]
        for k in range(1, nv - 1):
            v1 = verts_pidx[vert_idx + k]
            v2 = verts_pidx[vert_idx + k + 1]
            indices.extend([v0, v1, v2])
            materials_per_tri.append(materials)

    return dict(
        positions=positions,
        indices=indices,
        materials_per_tri=materials_per_tri,
        n_verts=len(pts3),
        n_tris=len(indices) // 3,
    )


def main():
    if len(sys.argv) < 2:
        print('usage: dig_parse.py <file.dig> [--mesh]', file=sys.stderr)
        sys.exit(1)
    path = Path(sys.argv[1])
    if '--mesh' in sys.argv:
        g = build_geometry(path)
        print(json.dumps({
            'n_verts': g['n_verts'],
            'n_tris': g['n_tris'],
            'positions_sample': g['positions'][:18],
            'indices_sample': g['indices'][:30],
            'materials_sample': g['materials_per_tri'][:10],
        }, indent=2))
    else:
        info = parse_dig(path)
        print(json.dumps(info, indent=2))


if __name__ == '__main__':
    main()

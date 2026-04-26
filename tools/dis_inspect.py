#!/usr/bin/env python3
"""Inspect a Tribes 1 DIS index file (header level only).

Spec (jamesu's gist, Interiors -> DIS Index):
    Tag 'ITRs'
    uint32 chunkSize
    int32 numStates
    State[numStates]: uint32 stateNameIdx, uint32 lodIdx, uint32 numLods
    int32 numLods
    Lod[numLods]: uint32 minPixels, uint32 geomNameIdx, uint32 lightStateIdx, uint32 linkableFaces
    int32 numLodLightStates
    LodLightState[N]: uint32 bits
    int32 numLightStates
    LightState[N]: uint32 bits
    int32 nameSize
    char[nameSize] names
    int32 materialListIdx
    bool linkedInterior
"""
import sys, struct
from pathlib import Path


def parse_dis(path: Path):
    data = path.read_bytes()
    p = 0
    tag = data[p:p+4]; p += 4
    if tag != b'ITRs':
        raise ValueError(f'unexpected tag {tag!r}')
    chunk_size = struct.unpack_from('<I', data, p)[0]; p += 4
    num_states = struct.unpack_from('<i', data, p)[0]; p += 4
    states = []
    for _ in range(num_states):
        s = struct.unpack_from('<III', data, p); p += 12
        states.append(s)
    num_lods_total = struct.unpack_from('<i', data, p)[0]; p += 4
    lods = []
    for _ in range(num_lods_total):
        l = struct.unpack_from('<IIII', data, p); p += 16
        lods.append(l)
    num_lod_lights = struct.unpack_from('<i', data, p)[0]; p += 4
    p += num_lod_lights * 4
    num_lights = struct.unpack_from('<i', data, p)[0]; p += 4
    p += num_lights * 4
    name_size = struct.unpack_from('<i', data, p)[0]; p += 4
    names_blob = data[p:p+name_size]; p += name_size
    mat_idx = struct.unpack_from('<i', data, p)[0]; p += 4
    linked = data[p]; p += 1

    name_offsets = []
    o = 0
    while o < len(names_blob):
        e = names_blob.find(b'\0', o)
        if e < 0: break
        name_offsets.append((o, names_blob[o:e].decode('latin-1','replace')))
        o = e + 1

    def name_at(idx):
        if 0 <= idx < len(names_blob):
            e = names_blob.find(b'\0', idx)
            return names_blob[idx:e].decode('latin-1','replace') if e>=0 else '?'
        return f'idx={idx}?'

    return {
        'tag': tag,
        'chunk_size': chunk_size,
        'num_states': num_states,
        'states': [
            {'state_name_idx': s[0], 'state_name': name_at(s[0]),
             'lod_idx': s[1], 'num_lods': s[2]}
            for s in states
        ],
        'num_lods': num_lods_total,
        'lods': [
            {'min_pixels': l[0], 'geom_name_idx': l[1], 'geom_name': name_at(l[1]),
             'light_state_idx': l[2], 'linkable_faces': l[3]}
            for l in lods
        ],
        'name_size': name_size,
        'names': name_offsets,
        'material_list_idx': mat_idx,
        'material_list': name_at(mat_idx),
        'linked_interior': linked,
        'consumed_bytes': p,
        'total_bytes': len(data),
    }


def main():
    if len(sys.argv) < 2:
        print("usage: dis_inspect.py <file.dis>", file=sys.stderr)
        sys.exit(1)
    info = parse_dis(Path(sys.argv[1]))
    import json
    print(json.dumps(info, indent=2, default=lambda b: b.decode('latin-1') if isinstance(b, bytes) else str(b)))


if __name__ == '__main__':
    main()

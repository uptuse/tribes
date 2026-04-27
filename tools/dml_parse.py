#!/usr/bin/env python3
"""Parse a Tribes 1 DML (TS::MaterialList) file into an ordered list of material names.

Binary layout (from Darkstar source: Ts3/Inc/ts_material.h + Ts3/code/ts_material.cpp):

    Tag 'PERS' (4 bytes)
    uint32 chunkSize
    String className 'TS::MaterialList' (uint16 len + chars, optional NUL)
    int32 version                       (typically 3 or 4)
    int32 fnDetails                     (number of detail levels, usually 1)
    int32 fnMaterials                   (number of materials per detail level)
    Material::Params[fnDetails * fnMaterials]:
        Version 4 (64 bytes each):
            Int32  fFlags           (4)  — MatNull=0, MatPalette=1, MatRGB=2, MatTexture=3
            RealF  fAlpha           (4)
            Int32  fIndex           (4)
            RGB    fRGB             (4)  — R,G,B,flags bytes
            char   fMapFile[32]     (32) — NUL-padded texture filename
            Int32  fType            (4)  — SurfaceType enum
            RealF  fElasticity      (4)
            RealF  fFriction        (4)
            UInt32 fUseDefaultProps (4)
        Version 3 (60 bytes — no fUseDefaultProps)
        Version 2 (44 bytes — no fType, fElasticity, fFriction, fUseDefaultProps)

We only need the fMapFile field from each material entry.
"""
from __future__ import annotations
import struct, sys, json
from pathlib import Path
from typing import List, Tuple


def _read_string(data: bytes, p: int) -> Tuple[str, int]:
    """Read uint16-prefixed string. Same encoding as DIG files."""
    length = struct.unpack_from('<H', data, p)[0]
    raw_len = length & 0x7FFF
    p += 2
    s = data[p:p+raw_len].decode('latin-1', 'replace')
    p += raw_len
    if p < len(data) and data[p] == 0:
        p += 1
    return s, p


def parse_dml(path: Path) -> dict:
    """Parse a .dml file and return material info.

    Returns dict with:
        version: int
        n_details: int
        n_materials: int
        materials: list[str]  — ordered texture filenames (first detail level only)
        all_materials: list[dict] — full info for every entry
    """
    data = path.read_bytes()
    p = 0

    # PERS header
    tag = data[p:p+4]; p += 4
    if tag != b'PERS':
        raise ValueError(f'unexpected tag {tag!r}')
    chunk_size = struct.unpack_from('<I', data, p)[0]; p += 4

    # className
    class_name, p = _read_string(data, p)
    if class_name != 'TS::MaterialList':
        raise ValueError(f'unexpected className {class_name!r}')

    # version (from Persistent framework)
    version = struct.unpack_from('<i', data, p)[0]; p += 4

    # MaterialList::read: fnDetails, fnMaterials
    fn_details = struct.unpack_from('<i', data, p)[0]; p += 4
    fn_materials = struct.unpack_from('<i', data, p)[0]; p += 4

    # Determine per-material byte size based on version
    if version >= 4:
        mat_size = 64  # full Params struct
    elif version == 3:
        mat_size = 60  # no fUseDefaultProps
    elif version == 2:
        mat_size = 44  # no fType, fElasticity, fFriction, fUseDefaultProps
    elif version == 1:
        mat_size = 48  # MapFilenameMaxV1=16 instead of 32, but has rest
        # v1: fFlags(4) + fAlpha(4) + fIndex(4) + fRGB(4) + fMapFile[16](16) + fType(4) + fElasticity(4) + fFriction(4) + fUseDefaultProps(4) = 48
        # Actually v1 is: sizeof(fParams) - (32-16) = 64 - 16 = 48
    else:
        raise ValueError(f'unsupported DML version {version}')

    total_mats = fn_details * fn_materials
    all_materials = []
    for i in range(total_mats):
        if p + mat_size > len(data):
            break

        f_flags = struct.unpack_from('<I', data, p)[0]
        f_alpha = struct.unpack_from('<f', data, p + 4)[0]
        f_index = struct.unpack_from('<i', data, p + 8)[0]
        f_rgb = data[p + 12:p + 16]

        # fMapFile offset depends on version
        if version == 1:
            map_file_raw = data[p + 16:p + 32]  # 16 bytes
        else:
            map_file_raw = data[p + 16:p + 48]  # 32 bytes

        # Extract NUL-terminated string from the fixed-size buffer
        nul_idx = map_file_raw.find(b'\0')
        if nul_idx >= 0:
            map_file = map_file_raw[:nul_idx].decode('latin-1', 'replace')
        else:
            map_file = map_file_raw.decode('latin-1', 'replace')

        # SurfaceType (if present)
        f_type = None
        if version >= 3:
            type_offset = 48 if version >= 2 else 32
            f_type = struct.unpack_from('<i', data, p + type_offset)[0]

        all_materials.append({
            'filename': map_file,
            'flags': f_flags,
            'alpha': f_alpha,
            'rgb': list(f_rgb[:3]),
            'surface_type': f_type,
        })

        p += mat_size

    # First detail level materials (what the game actually uses)
    materials = [m['filename'] for m in all_materials[:fn_materials]]

    return dict(
        version=version,
        n_details=fn_details,
        n_materials=fn_materials,
        materials=materials,
        all_materials=all_materials,
    )


def parse_dml_names(path: Path) -> List[str]:
    """Convenience: return just the ordered list of texture filenames."""
    return parse_dml(path)['materials']


def main():
    if len(sys.argv) < 2:
        print('usage: dml_parse.py <file.dml> [--names-only]', file=sys.stderr)
        sys.exit(1)
    path = Path(sys.argv[1])
    if '--names-only' in sys.argv:
        names = parse_dml_names(path)
        for i, n in enumerate(names):
            print(f'  [{i}] {n}')
    else:
        info = parse_dml(path)
        print(json.dumps(info, indent=2))


if __name__ == '__main__':
    main()

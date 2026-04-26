#!/usr/bin/env python3
"""
PVOL archive extractor for Tribes 1 .vol files.

Format reference: https://gist.github.com/jamesu/9d25c16d5d11b402f9dc75d11df76177
(lines 76-131 of jamesu_formats.txt cached in /tmp/).

Usage:
    python3 vol_extract.py list   <vol_file>
    python3 vol_extract.py extract <vol_file> <out_dir> [<glob>...]

Examples:
    python3 vol_extract.py list   assets/tribes_original/base/lushWorld.vol
    python3 vol_extract.py extract assets/tribes_original/base/lushWorld.vol /tmp/lushworld
    python3 vol_extract.py extract assets/tribes_original/base/lushWorld.vol /tmp/raindance '*flag*' '*bridge*'

Notes:
    - PVOL = newer format (post Tribes 1 release).
    - VOL  = older format (pre-release builds).
    - We support both layouts. Compression types: 0=none, 1=RLE, 2=lzss, 3=lha.
      In the actual Tribes 1 v1.11 ship, compressType is 0 in every file we
      need (verified empirically); we error loudly if we ever encounter
      compressed data so the gap is obvious.
"""
import sys
import struct
import fnmatch
from pathlib import Path


def chunksize_decode(raw: int) -> int:
    """A ChunkSize where the high bit indicates dword alignment."""
    return ((raw & 0x7FFFFFFF) + 3) & ~3


def read_pvol(data: bytes):
    """Returns list[(name, offset, size, compress)] for a PVOL archive."""
    if data[:4] != b'PVOL':
        return None
    string_block_offset = struct.unpack_from('<I', data, 4)[0]

    if data[string_block_offset:string_block_offset + 4] != b'vols':
        raise ValueError(f'expected "vols" tag at 0x{string_block_offset:x}, '
                         f'got {data[string_block_offset:string_block_offset+4]!r}')
    vols_size = struct.unpack_from('<I', data, string_block_offset + 4)[0]
    vols_size = chunksize_decode(vols_size)
    string_data_start = string_block_offset + 8
    string_data = data[string_data_start:string_data_start + vols_size]

    voli_off = string_data_start + vols_size
    if data[voli_off:voli_off + 4] != b'voli':
        raise ValueError(f'expected "voli" tag at 0x{voli_off:x}, '
                         f'got {data[voli_off:voli_off+4]!r}')
    voli_size_raw = struct.unpack_from('<I', data, voli_off + 4)[0]
    voli_size = chunksize_decode(voli_size_raw)
    voli_size_unpadded = voli_size_raw & 0x7FFFFFFF
    entry_off = voli_off + 8

    # Each entry: uint32 id, int32 filenameOffset, int32 fileOffset,
    #             uint32 size, uint8 compressType  -> 17 bytes typically.
    # In practice the entries are 17 bytes packed (no padding from spec).
    # Some PVOL builds use 18 with a trailing pad byte. Try both.
    for entry_size in (17, 18, 20):
        if voli_size_unpadded % entry_size != 0:
            continue
        n = voli_size_unpadded // entry_size
        entries = []
        ok = True
        for i in range(n):
            o = entry_off + i * entry_size
            try:
                _id = struct.unpack_from('<I', data, o)[0]
                fname_off = struct.unpack_from('<i', data, o + 4)[0]
                file_off = struct.unpack_from('<i', data, o + 8)[0]
                sz = struct.unpack_from('<I', data, o + 12)[0]
                comp = struct.unpack_from('<B', data, o + 16)[0]
            except struct.error:
                ok = False
                break
            # Read NUL-terminated filename from string_data
            name_end = string_data.find(b'\0', fname_off)
            if name_end < 0:
                ok = False
                break
            name = string_data[fname_off:name_end].decode('latin-1', errors='replace')
            if not name or any(b < 0x20 or b > 0x7E for b in name.encode('latin-1', 'replace')):
                ok = False
                break
            entries.append((name, file_off, sz, comp))
        if ok and entries:
            return entries

    raise ValueError(f'could not parse PVOL voli (size={voli_size}) at 0x{entry_off:x}')


def read_vol_old(data: bytes):
    """Older 'VOL ' format. Returns list[(name, offset, size, compress)]."""
    if data[:4] != b'VOL ':
        return None
    # Tag 'VOL ', then 'volh', then 'vols', uint32 unknown, char[size-4] strings,
    # then 'voli', then entries.
    p = 4
    if data[p:p + 4] != b'volh':
        raise ValueError("expected 'volh'")
    p += 4
    if data[p:p + 4] != b'vols':
        raise ValueError("expected 'vols'")
    p += 4
    size_field = struct.unpack_from('<I', data, p)[0]
    p += 4
    string_data = data[p + 4:p + size_field]  # +4 skips the unknown uint32
    p += size_field
    if data[p:p + 4] != b'voli':
        raise ValueError("expected 'voli'")
    p += 4
    voli_size = struct.unpack_from('<I', data, p)[0]
    p += 4
    entry_off = p
    # Each entry: int32 id, uint32 offset, uint32 size, uint8 compress, uint8 padding = 14 bytes
    for entry_size in (14, 16):
        if voli_size % entry_size != 0:
            continue
        n = voli_size // entry_size
        entries = []
        ok = True
        for i in range(n):
            o = entry_off + i * entry_size
            id_ = struct.unpack_from('<i', data, o)[0]
            file_off = struct.unpack_from('<I', data, o + 4)[0]
            sz = struct.unpack_from('<I', data, o + 8)[0]
            comp = struct.unpack_from('<B', data, o + 12)[0]
            if id_ < 0 or id_ >= len(string_data):
                ok = False
                break
            name_end = string_data.find(b'\0', id_)
            if name_end < 0:
                ok = False
                break
            name = string_data[id_:name_end].decode('latin-1', 'replace')
            entries.append((name, file_off, sz, comp))
        if ok and entries:
            return entries
    raise ValueError("could not parse VOL voli")


def list_archive(vol_path: Path):
    data = vol_path.read_bytes()
    entries = read_pvol(data) if data[:4] == b'PVOL' else read_vol_old(data)
    if entries is None:
        print(f"unknown archive type: tag={data[:4]!r}", file=sys.stderr)
        sys.exit(1)
    return data, entries


def cmd_list(vol_path: Path):
    data, entries = list_archive(vol_path)
    print(f"# {vol_path.name}: {len(entries)} files")
    for name, off, sz, comp in entries:
        comp_str = ['none', 'rle', 'lzss', 'lha'][comp] if comp < 4 else f'?{comp}'
        print(f"  {sz:>10}  {comp_str:>5}  {name}")


def read_vblk(data: bytes, file_off: int, size: int, compress: int) -> bytes:
    """Read VBLK chunk at file_off and return the raw file bytes."""
    if data[file_off:file_off + 4] != b'VBLK':
        # Sometimes the offset is the start of the data, not the VBLK header
        # (the spec is ambiguous in places). Try both.
        body = data[file_off:file_off + size]
    else:
        # 'VBLK' + ChunkSize + body
        encoded_size = struct.unpack_from('<I', data, file_off + 4)[0]
        body_off = file_off + 8
        body = data[body_off:body_off + size]
    if compress != 0:
        raise NotImplementedError(
            f'compression type {compress} not implemented; '
            'add LZH/LZSS/RLE decoder before extracting this archive')
    return body


def cmd_extract(vol_path: Path, out_dir: Path, patterns):
    data, entries = list_archive(vol_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    if patterns:
        wanted = lambda n: any(fnmatch.fnmatchcase(n, p) for p in patterns)
    else:
        wanted = lambda n: True
    n_extracted = 0
    n_skipped = 0
    for name, off, sz, comp in entries:
        if not wanted(name):
            n_skipped += 1
            continue
        try:
            body = read_vblk(data, off, sz, comp)
        except Exception as e:
            print(f"  ERROR {name}: {e}", file=sys.stderr)
            continue
        out = out_dir / name
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(body)
        print(f"  -> {out} ({sz} bytes)")
        n_extracted += 1
    print(f"# extracted {n_extracted}, skipped {n_skipped}")


def main():
    argv = sys.argv[1:]
    if not argv:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    cmd = argv[0]
    if cmd == 'list':
        cmd_list(Path(argv[1]))
    elif cmd == 'extract':
        cmd_extract(Path(argv[1]), Path(argv[2]), argv[3:])
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()

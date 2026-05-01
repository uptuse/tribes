#!/usr/bin/env python3
"""
Convert GLB files to OBJ+MTL for Mixamo upload.
Usage: python3 tools/glb_to_obj.py assets/models/50k/iron_wolf_50k.glb
Output: tools/obj_export/<modelname>.obj + .mtl (ready to zip and upload to Mixamo)
"""

import sys, os, struct, json, base64, zipfile
from pathlib import Path

try:
    from pygltflib import GLTF2
except ImportError:
    print("Installing pygltflib..."); os.system("pip3 install pygltflib -q")
    from pygltflib import GLTF2

import numpy as np

OUT_DIR = Path(__file__).parent / "obj_export"
OUT_DIR.mkdir(exist_ok=True)

def get_accessor_data(gltf, accessor_idx):
    if accessor_idx is None: return None
    acc   = gltf.accessors[accessor_idx]
    bv    = gltf.bufferViews[acc.bufferView]
    buf   = gltf.buffers[bv.buffer]
    # Decode buffer data
    data  = gltf._glb_data if buf.uri is None else base64.b64decode(buf.uri.split(",")[1])
    start = bv.byteOffset + (acc.byteOffset or 0)
    type_map = {"SCALAR":1,"VEC2":2,"VEC3":3,"VEC4":4,"MAT2":4,"MAT3":9,"MAT4":16}
    comp_size = {5120:1,5121:1,5122:2,5123:2,5125:4,5126:4}
    fmt_char  = {5120:"b",5121:"B",5122:"h",5123:"H",5125:"I",5126:"f"}
    n_comp    = type_map[acc.type]
    c_size    = comp_size[acc.componentType]
    fmt       = fmt_char[acc.componentType]
    stride    = bv.byteStride or (n_comp * c_size)
    result    = []
    for i in range(acc.count):
        off = start + i * stride
        vals = struct.unpack_from(f"{n_comp}{fmt}", data, off)
        result.append(vals)
    return result

def convert(glb_path):
    glb_path = Path(glb_path)
    name     = glb_path.stem
    print(f"Loading {glb_path.name}...")
    gltf     = GLTF2().load(str(glb_path))

    obj_lines = [f"# Converted from {glb_path.name}", f"mtllib {name}.mtl", ""]
    mtl_lines = [f"# Materials for {name}"]

    vtx_offset = 1  # OBJ is 1-indexed
    mat_names  = set()

    for mi, mesh in enumerate(gltf.meshes):
        print(f"  Mesh {mi}: {mesh.name or 'unnamed'} ({len(mesh.primitives)} primitives)")
        for pi, prim in enumerate(mesh.primitives):
            mat_idx  = prim.material
            mat_name = f"mat_{mat_idx}" if mat_idx is not None else "default"
            mat_names.add((mat_name, mat_idx))

            pos  = get_accessor_data(gltf, prim.attributes.POSITION)
            norm = get_accessor_data(gltf, getattr(prim.attributes, "NORMAL", None))
            uv   = get_accessor_data(gltf, getattr(prim.attributes, "TEXCOORD_0", None))
            idx  = get_accessor_data(gltf, prim.indices)

            if not pos: continue

            obj_lines.append(f"# Mesh {mi} Primitive {pi}")
            for v in pos:
                obj_lines.append(f"v {v[0]:.6f} {v[1]:.6f} {v[2]:.6f}")
            if norm:
                for n in norm:
                    obj_lines.append(f"vn {n[0]:.6f} {n[1]:.6f} {n[2]:.6f}")
            if uv:
                for t in uv:
                    obj_lines.append(f"vt {t[0]:.6f} {1-t[1]:.6f}")  # flip V

            obj_lines.append(f"usemtl {mat_name}")
            obj_lines.append(f"g mesh{mi}_prim{pi}")

            indices = [i[0] for i in idx] if idx else list(range(len(pos)))
            for tri in range(0, len(indices)-2, 3):
                a = indices[tri]   + vtx_offset
                b = indices[tri+1] + vtx_offset
                c = indices[tri+2] + vtx_offset
                if norm and uv:
                    obj_lines.append(f"f {a}/{a}/{a} {b}/{b}/{b} {c}/{c}/{c}")
                elif norm:
                    obj_lines.append(f"f {a}//{a} {b}//{b} {c}//{c}")
                elif uv:
                    obj_lines.append(f"f {a}/{a} {b}/{b} {c}/{c}")
                else:
                    obj_lines.append(f"f {a} {b} {c}")

            vtx_offset += len(pos)

    # Write MTL
    for mat_name, mat_idx in mat_names:
        mtl_lines += [f"\nnewmtl {mat_name}", "Ka 1 1 1", "Kd 0.8 0.8 0.8", "Ks 0 0 0", "d 1"]
        if mat_idx is not None and mat_idx < len(gltf.materials):
            m = gltf.materials[mat_idx]
            if m.pbrMetallicRoughness and m.pbrMetallicRoughness.baseColorFactor:
                c = m.pbrMetallicRoughness.baseColorFactor
                mtl_lines.append(f"Kd {c[0]:.4f} {c[1]:.4f} {c[2]:.4f}")

    obj_path = OUT_DIR / f"{name}.obj"
    mtl_path = OUT_DIR / f"{name}.mtl"
    zip_path = OUT_DIR / f"{name}.zip"

    obj_path.write_text("\n".join(obj_lines))
    mtl_path.write_text("\n".join(mtl_lines))

    with zipfile.ZipFile(zip_path, "w") as z:
        z.write(obj_path, obj_path.name)
        z.write(mtl_path, mtl_path.name)

    print(f"  → {zip_path}")
    print(f"     Upload this ZIP to mixamo.com → Auto-Rigger")
    return zip_path

if __name__ == "__main__":
    paths = sys.argv[1:] or sorted(Path("assets/models/50k").glob("*.glb"))
    if not paths:
        print("Usage: python3 tools/glb_to_obj.py <file.glb> [file2.glb ...]")
        print("       or run from project root with no args to convert all 50k models")
        sys.exit(1)
    for p in paths:
        try:
            convert(p)
        except Exception as e:
            print(f"  ERROR {p}: {e}")
    print("\nDone. Upload the .zip files from tools/obj_export/ to mixamo.com")

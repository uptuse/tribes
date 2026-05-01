#!/usr/bin/env python3
"""
add_skin_weights.py — Transfer the skeleton from crimson_sentinel_rigged.glb
onto other rigged GLBs that have mesh geometry but no skin binding.

The Mixamo "Without Skin" download gave us the skeleton + animations but no
skin weights. This script:
1. Reads the SOURCE rig (crimson_sentinel) to extract bone world positions
2. Reads each TARGET GLB (has mesh + skeleton nodes, no skin weights)
3. Computes proximity-based skin weights (4 nearest bones per vertex)
4. Writes a new rigged GLB with proper GLTF skin binding

Usage:
    python3 tools/add_skin_weights.py
"""

import sys, struct, base64, json, copy
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from pygltflib import GLTF2, BufferView, Accessor, Skin, FLOAT, UNSIGNED_SHORT, \
                      VEC4, SCALAR, ARRAY_BUFFER

BASE     = Path(__file__).parent.parent / 'assets' / 'models'
SOURCE   = BASE / 'crimson_sentinel_rigged.glb'
TARGETS  = [
    'emerald_sentinel',
    'midnight_sentinel',
    'obsidian_vanguard',
]
N_INFL   = 4   # influences per vertex (standard = 4)
MIN_DIST = 0.001  # prevent divide-by-zero

# ── helpers ────────────────────────────────────────────────────────────────

def get_data(g, accessor_idx):
    """Return numpy array for a GLTF accessor."""
    acc  = g.accessors[accessor_idx]
    bv   = g.bufferViews[acc.bufferView]
    blob = g._glb_data[bv.byteOffset + (acc.byteOffset or 0):]
    count = acc.count
    if acc.type == 'VEC3': shape, fmt = (count, 3), 'f'
    elif acc.type == 'VEC4': shape, fmt = (count, 4), 'f'
    elif acc.type == 'MAT4': shape, fmt = (count, 4, 4), 'f'
    elif acc.type == 'SCALAR':
        if acc.componentType == FLOAT: shape, fmt = (count,), 'f'
        else: shape, fmt = (count,), 'H'
    else: raise ValueError(f'Unsupported type {acc.type}')
    stride = bv.byteStride or (struct.calcsize(fmt) * (shape[1] if len(shape) > 1 else 1))
    arr = np.zeros(shape, dtype='f4' if fmt == 'f' else 'u2')
    elem_size = struct.calcsize(fmt) * (shape[1] if len(shape) > 1 else 1)
    for i in range(count):
        row = struct.unpack_from(f'{shape[1] if len(shape)>1 else 1}{fmt}', blob, i * stride)
        if len(shape) == 1: arr[i] = row[0]
        else: arr[i] = row
    return arr

def trs_to_mat4(t=None, r=None, s=None):
    """Build 4×4 matrix from TRS (translation, quaternion rotation, scale)."""
    mat = np.eye(4, dtype='f4')
    if s: mat[:3,:3] *= np.array(s, 'f4')
    if r:
        qx,qy,qz,qw = r
        mat[:3,:3] = np.array([
            [1-2*(qy*qy+qz*qz), 2*(qx*qy-qz*qw), 2*(qx*qz+qy*qw)],
            [2*(qx*qy+qz*qw), 1-2*(qx*qx+qz*qz), 2*(qy*qz-qx*qw)],
            [2*(qx*qz-qy*qw), 2*(qy*qz+qx*qw), 1-2*(qx*qx+qy*qy)],
        ], 'f4') @ mat[:3,:3]
    if t: mat[:3,3] = t
    return mat

def get_node_world_matrices(g):
    """Compute world-space 4×4 matrix for every node."""
    n = len(g.nodes)
    local = [trs_to_mat4(
        nd.translation, nd.rotation, nd.scale
    ) if (nd.translation or nd.rotation or nd.scale) else np.eye(4, dtype='f4')
    for nd in g.nodes]
    world = [None]*n
    def calc(i, parent=np.eye(4, dtype='float32')):
        world[i] = parent @ local[i]
        for c in (g.nodes[i].children or []):
            calc(c, world[i])
    for s in (g.scenes[g.scene].nodes if g.scene is not None else []):
        calc(s)
    return world

def append_blob(g, data_bytes, target, component_type, dtype, count, acc_type, normalized=False):
    """Append raw bytes to the GLB binary blob and create bufferView + accessor."""
    start = len(g._glb_data)
    # Pad to 4-byte alignment
    pad = (4 - len(data_bytes) % 4) % 4
    g._glb_data += data_bytes + b'\x00'*pad

    bv_idx = len(g.bufferViews)
    g.bufferViews.append(BufferView(buffer=0, byteOffset=start, byteLength=len(data_bytes), target=target))

    acc_idx = len(g.accessors)
    arr = np.frombuffer(data_bytes, dtype=dtype).reshape(-1, {'VEC4':4,'SCALAR':1}[acc_type])
    mn = arr.min(axis=0).tolist() if acc_type == 'VEC4' else [float(arr.min())]
    mx = arr.max(axis=0).tolist() if acc_type == 'VEC4' else [float(arr.max())]
    g.accessors.append(Accessor(
        bufferView=bv_idx, componentType=component_type,
        count=count, type=acc_type, normalized=normalized,
        min=mn, max=mx,
    ))
    return acc_idx

# ── main ───────────────────────────────────────────────────────────────────

def process(target_id):
    src_path = SOURCE
    tgt_path = BASE / f'{target_id}_rigged.glb'
    out_path = BASE / f'{target_id}_rigged.glb'

    print(f'\n── {target_id} ──────────────────────────')
    src = GLTF2().load(str(src_path))
    tgt = GLTF2().load(str(tgt_path))

    # ── 1. Extract source skeleton joint names + world positions ───────────
    if not src.skins:
        print('  ERROR: source has no skins'); return

    src_skin  = src.skins[0]
    src_world = get_node_world_matrices(src)
    joint_positions = []  # world-space origin of each joint
    for ji in src_skin.joints:
        w = src_world[ji] if src_world[ji] is not None else np.eye(4, dtype='float32')
        joint_positions.append(w[:3, 3])  # translation column
    joint_positions = np.array(joint_positions, 'f4')
    n_joints = len(src_skin.joints)
    print(f'  Source joints: {n_joints}')

    # Inverse bind matrices from source
    ibm_data = get_data(src, src_skin.inverseBindMatrices).reshape(n_joints, 4, 4)

    # ── 2. Find mesh primitives in target ──────────────────────────────────
    mesh_prims = []
    for mi, mesh in enumerate(tgt.meshes):
        for pi, prim in enumerate(mesh.primitives):
            if prim.attributes.POSITION is not None:
                mesh_prims.append((mi, pi, prim))
    if not mesh_prims:
        print('  ERROR: no mesh primitives found'); return
    print(f'  Target mesh primitives: {len(mesh_prims)}')

    # ── 3. Rebuild target binary blob ──────────────────────────────────────
    # We need to keep existing mesh data and append new skin accessors.
    # Copy the existing blob.
    tgt._glb_data = bytearray(tgt._glb_data or b'')

    for mi, pi, prim in mesh_prims:
        verts = get_data(tgt, prim.attributes.POSITION)   # (N, 3)
        n_verts = len(verts)
        print(f'  Mesh {mi} prim {pi}: {n_verts} vertices')

        # ── 4. Proximity skinning ──────────────────────────────────────────
        # Normalise vertex scale to ~1.8m height for distance comparison
        bbox_h = verts[:,1].max() - verts[:,1].min()
        scale  = 1.8 / bbox_h if bbox_h > 0.01 else 1.0

        # Also normalise joint positions (source is at 0.01 Mixamo scale)
        jp_scale  = joint_positions * 100.0  # 0.01 → 1.0
        jp_h = jp_scale[:,1].max() - jp_scale[:,1].min()
        jp_s = 1.8 / jp_h if jp_h > 0.01 else 1.0
        jp_norm = jp_scale * jp_s

        v_norm = verts * scale
        # Re-centre both on origin
        jp_norm -= jp_norm.mean(axis=0)
        v_norm  -= v_norm.mean(axis=0)

        joints_out  = np.zeros((n_verts, 4), dtype='u2')
        weights_out = np.zeros((n_verts, 4), dtype='f4')

        for vi, v in enumerate(v_norm):
            dists = np.linalg.norm(jp_norm - v, axis=1) + MIN_DIST
            # Pick N_INFL nearest
            idx = np.argpartition(dists, min(N_INFL, n_joints-1))[:N_INFL]
            idx = idx[np.argsort(dists[idx])]
            w   = 1.0 / (dists[idx] ** 2)
            w  /= w.sum()
            joints_out[vi,  :len(idx)] = idx.astype('u2')
            weights_out[vi, :len(idx)] = w.astype('f4')

        # ── 5. Append JOINTS_0 and WEIGHTS_0 accessors ────────────────────
        j_bytes = joints_out.tobytes()
        w_bytes = weights_out.tobytes()
        j_acc = append_blob(tgt, j_bytes, ARRAY_BUFFER, UNSIGNED_SHORT, 'u2', n_verts, 'VEC4')
        w_acc = append_blob(tgt, w_bytes, ARRAY_BUFFER, FLOAT,          'f4', n_verts, 'VEC4')

        tgt.meshes[mi].primitives[pi].attributes.JOINTS_0  = j_acc
        tgt.meshes[mi].primitives[pi].attributes.WEIGHTS_0 = w_acc

    # ── 6. Copy skeleton nodes from source → target ────────────────────────
    # Append source joint nodes (the Mixamo bone hierarchy)
    src_joint_indices = set(src_skin.joints)
    node_map = {}  # src node idx → new tgt node idx

    def copy_node(src_idx):
        if src_idx in node_map: return node_map[src_idx]
        sn = src.nodes[src_idx]
        new_idx = len(tgt.nodes)
        node_map[src_idx] = new_idx
        new_node = copy.deepcopy(sn)
        new_node.children = []
        tgt.nodes.append(new_node)
        for c in (sn.children or []):
            copy_node(c)
        tgt.nodes[new_idx].children = [node_map[c] for c in (sn.children or [])]
        return new_idx

    # Find root joints (joints with no joint parent)
    all_joint_children = set()
    for ji in src_skin.joints:
        for c in (src.nodes[ji].children or []):
            all_joint_children.add(c)
    root_joints = [j for j in src_skin.joints if j not in all_joint_children]

    for rj in root_joints:
        copy_node(rj)
        # Attach root joint to scene root
        tgt.scenes[tgt.scene or 0].nodes.append(node_map[rj])

    # ── 7. Append inverse bind matrices from source ────────────────────────
    ibm_bytes = ibm_data.astype('f4').tobytes()
    ibm_start = len(tgt._glb_data)
    pad = (4 - len(ibm_bytes) % 4) % 4
    tgt._glb_data += ibm_bytes + b'\x00'*pad
    ibm_bv = len(tgt.bufferViews)
    tgt.bufferViews.append(BufferView(buffer=0, byteOffset=ibm_start, byteLength=len(ibm_bytes)))
    ibm_acc = len(tgt.accessors)
    tgt.accessors.append(Accessor(
        bufferView=ibm_bv, componentType=FLOAT,
        count=n_joints, type='MAT4',
    ))

    # ── 8. Create skin ─────────────────────────────────────────────────────
    new_joint_indices = [node_map[j] for j in src_skin.joints]
    new_skin_idx = len(tgt.skins)
    tgt.skins.append(Skin(
        joints=new_joint_indices,
        inverseBindMatrices=ibm_acc,
        name='MixamoRig',
    ))

    # Apply skin to all mesh primitives via their parent nodes
    for node in tgt.nodes:
        if node.mesh is not None and node.skin is None:
            node.skin = new_skin_idx

    # ── 9. Update buffer byte length and save ─────────────────────────────
    tgt.buffers[0].byteLength = len(tgt._glb_data)
    tgt.save(str(out_path))
    print(f'  ✓ Saved: {out_path.name}  ({len(tgt._glb_data)//1024} KB)')

if __name__ == '__main__':
    ids = sys.argv[1:] or TARGETS
    for tid in ids:
        try:
            process(tid)
        except Exception as e:
            import traceback
            print(f'  FAILED {tid}: {e}')
            traceback.print_exc()
    print('\nDone.')

"""
Batch decimation pipeline for Firewolf character models.
Processes all Meshy FBX exports → LOD0/LOD1/LOD2 GLBs with proper PBR materials.

Usage:
  blender --background --python batch_decimate.py -- <model_slug> <fbx_dir> <output_dir>

Per PIPELINE_RULES.md:
- Meshy FBX "texture" export is already ~10k tris (IS the LOD0 source)
- External PNGs used (not embedded FBX textures)
- Export as WEBP (not JPEG, not PNG)
- Color spaces: albedo/emission = sRGB, normal/metallic/roughness = Non-Color
- Mesh cleanup: remove doubles, recalc normals, remove non-mesh objects
"""
import bpy
import bmesh
import os
import sys
import glob

# Parse args after "--"
argv = sys.argv[sys.argv.index("--") + 1:]
MODEL_SLUG = argv[0]       # e.g. "crimson_sentinel"
FBX_DIR = argv[1]          # directory containing .fbx and texture .pngs
OUTPUT_DIR = argv[2]       # where to write GLBs

# Find the FBX file
fbx_files = glob.glob(os.path.join(FBX_DIR, "*.fbx"))
if not fbx_files:
    print(f"ERROR: No FBX found in {FBX_DIR}")
    sys.exit(1)
FBX_PATH = fbx_files[0]

# Find texture PNGs
def find_tex(suffix):
    """Find texture file by suffix pattern."""
    patterns = [f"*_{suffix}.png", f"*{suffix}.png"]
    for pat in patterns:
        matches = glob.glob(os.path.join(FBX_DIR, pat))
        if matches:
            return matches[0]
    return None

TEX_ALBEDO = find_tex("texture") 
TEX_NORMAL = find_tex("normal")
TEX_METALLIC = find_tex("metallic")
TEX_ROUGHNESS = find_tex("roughness")
TEX_EMISSION = find_tex("emission")

# The albedo is the one without any suffix besides "texture"
# Actually in Meshy exports, albedo is named just "*_texture.png"
# Let's be more careful
all_pngs = glob.glob(os.path.join(FBX_DIR, "*.png"))
for p in all_pngs:
    bn = os.path.basename(p).lower()
    if "normal" in bn:
        TEX_NORMAL = p
    elif "metallic" in bn:
        TEX_METALLIC = p
    elif "roughness" in bn:
        TEX_ROUGHNESS = p
    elif "emission" in bn:
        TEX_EMISSION = p
    else:
        TEX_ALBEDO = p  # The remaining one is albedo

print(f"Model: {MODEL_SLUG}")
print(f"FBX: {FBX_PATH}")
print(f"Textures: albedo={TEX_ALBEDO is not None}, normal={TEX_NORMAL is not None}, "
      f"metallic={TEX_METALLIC is not None}, roughness={TEX_ROUGHNESS is not None}, "
      f"emission={TEX_EMISSION is not None}")

LOD_CONFIG = [
    # (suffix, target_tris, tex_size)
    ("50k", 50000, 4096),      # Rigging source for Mixamo (not shipped in game)
    ("lod0", 20000, 2048),     # Decimate to 10k, 2K textures (close range)
    ("lod1", 3000, 1024),      # Decimate to 3k, 1K textures (mid range)
    ("lod2", 500, 512),        # Decimate to 500, 512 textures (far range)
]

def clean_scene():
    """Reset Blender to empty state."""
    bpy.ops.wm.read_factory_settings(use_empty=True)

def import_fbx():
    """Import FBX and return mesh objects."""
    bpy.ops.import_scene.fbx(filepath=FBX_PATH)
    meshes = [obj for obj in bpy.data.objects if obj.type == 'MESH']
    # Remove non-mesh objects
    for obj in list(bpy.data.objects):
        if obj.type != 'MESH':
            bpy.data.objects.remove(obj, do_unlink=True)
    return meshes

def count_tris(obj):
    """Count triangles in a mesh object."""
    mesh = obj.data
    mesh.calc_loop_triangles()
    count = len(mesh.loop_triangles)
    return count

def cleanup_mesh(obj):
    """Remove doubles and recalculate normals."""
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=0.0001)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')

def decimate_to(obj, target_tris):
    """Apply decimation modifier to reach target tri count."""
    current = count_tris(obj)
    if current <= target_tris:
        print(f"  Already at {current} tris (target {target_tris}), skipping decimation")
        return
    
    ratio = target_tris / current
    print(f"  Decimating {current} → {target_tris} tris (ratio {ratio:.4f})")
    
    mod = obj.modifiers.new(name="Decimate", type='DECIMATE')
    mod.decimate_type = 'COLLAPSE'
    mod.ratio = ratio
    mod.use_collapse_triangulate = True
    
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)
    
    final = count_tris(obj)
    print(f"  Result: {final} tris")

def load_texture(path, name, colorspace='sRGB'):
    """Load a texture image and set color space."""
    if path is None:
        return None
    img = bpy.data.images.load(path)
    img.name = name
    img.colorspace_settings.name = colorspace
    return img

def resize_and_pack(img, size):
    """Resize image to size×size and pack into blend file."""
    if img is None:
        return
    if img.size[0] != size or img.size[1] != size:
        img.scale(size, size)
    img.pack()

def setup_material(obj, tex_size):
    """Create PBR material with all texture maps."""
    # Clear existing materials
    obj.data.materials.clear()
    
    mat = bpy.data.materials.new(name=f"{MODEL_SLUG}_mat")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    
    # Clear default nodes
    for node in nodes:
        nodes.remove(node)
    
    # Create output and principled BSDF
    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (400, 0)
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (0, 0)
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
    
    x_offset = -400
    
    # Albedo
    albedo_img = load_texture(TEX_ALBEDO, "albedo", 'sRGB')
    if albedo_img:
        resize_and_pack(albedo_img, tex_size)
        tex_node = nodes.new('ShaderNodeTexImage')
        tex_node.image = albedo_img
        tex_node.location = (x_offset, 300)
        links.new(tex_node.outputs['Color'], bsdf.inputs['Base Color'])
    
    # Normal map
    normal_img = load_texture(TEX_NORMAL, "normal", 'Non-Color')
    if normal_img:
        resize_and_pack(normal_img, tex_size)
        tex_node = nodes.new('ShaderNodeTexImage')
        tex_node.image = normal_img
        tex_node.location = (x_offset, 0)
        normal_map = nodes.new('ShaderNodeNormalMap')
        normal_map.inputs['Strength'].default_value = 0.8
        normal_map.location = (x_offset + 300, 0)
        links.new(tex_node.outputs['Color'], normal_map.inputs['Color'])
        links.new(normal_map.outputs['Normal'], bsdf.inputs['Normal'])
    
    # Metallic
    metallic_img = load_texture(TEX_METALLIC, "metallic", 'Non-Color')
    if metallic_img:
        resize_and_pack(metallic_img, tex_size)
        tex_node = nodes.new('ShaderNodeTexImage')
        tex_node.image = metallic_img
        tex_node.location = (x_offset, -300)
        links.new(tex_node.outputs['Color'], bsdf.inputs['Metallic'])
    
    # Roughness
    roughness_img = load_texture(TEX_ROUGHNESS, "roughness", 'Non-Color')
    if roughness_img:
        resize_and_pack(roughness_img, tex_size)
        tex_node = nodes.new('ShaderNodeTexImage')
        tex_node.image = roughness_img
        tex_node.location = (x_offset, -600)
        links.new(tex_node.outputs['Color'], bsdf.inputs['Roughness'])
    
    # Emission
    emission_img = load_texture(TEX_EMISSION, "emission", 'sRGB')
    if emission_img:
        resize_and_pack(emission_img, tex_size)
        tex_node = nodes.new('ShaderNodeTexImage')
        tex_node.image = emission_img
        tex_node.location = (x_offset, -900)
        links.new(tex_node.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = 1.0
    
    obj.data.materials.append(mat)

def export_glb(filepath):
    """Export scene as GLB with WEBP textures."""
    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format='GLB',
        export_image_format='WEBP',
        export_materials='EXPORT',
        export_normals=True,
        export_tangents=True,
        use_active_scene=True,
    )
    size_mb = os.path.getsize(filepath) / (1024*1024)
    print(f"  Exported: {filepath} ({size_mb:.1f} MB)")

# Main processing loop
os.makedirs(OUTPUT_DIR, exist_ok=True)

for suffix, target_tris, tex_size in LOD_CONFIG:
    print(f"\n{'='*60}")
    print(f"Processing {MODEL_SLUG}_{suffix} (target: {target_tris or 'as-is'} tris, {tex_size}px textures)")
    print(f"{'='*60}")
    
    # Fresh import each time
    clean_scene()
    meshes = import_fbx()
    
    if not meshes:
        print("ERROR: No meshes imported!")
        continue
    
    # Join all mesh objects into one
    if len(meshes) > 1:
        for obj in bpy.data.objects:
            obj.select_set(obj.type == 'MESH')
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
    
    obj = [o for o in bpy.data.objects if o.type == 'MESH'][0]
    bpy.context.view_layer.objects.active = obj
    total_tris = count_tris(obj)
    print(f"  Source: {total_tris:,} tris")
    
    # Cleanup
    cleanup_mesh(obj)
    
    # Decimate if needed
    if target_tris is not None:
        decimate_to(obj, target_tris)
    
    # Setup PBR material with sized textures
    setup_material(obj, tex_size)
    
    # Export
    output_path = os.path.join(OUTPUT_DIR, f"{MODEL_SLUG}_{suffix}.glb")
    export_glb(output_path)

print(f"\n{'='*60}")
print(f"DONE: {MODEL_SLUG} — all LODs exported to {OUTPUT_DIR}")
print(f"{'='*60}")

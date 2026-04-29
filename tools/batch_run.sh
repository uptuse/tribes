#!/bin/bash
# Batch process all 12 Meshy models through the decimation pipeline.
# Processes one at a time to manage /tmp space.

BLENDER=~/workspace/blender-4.3.0-linux-x64/blender
SCRIPT=~/workspace/tribes/tools/batch_decimate.py
OUTPUT=~/workspace/tribes/assets/models
MODELS_DIR=/tmp/meshy_models

# Model manifest: slug|team_dir|meshy_prefix
MODELS=(
  "crimson_warforged|Blood Eagle|Meshy_AI_Crimson_Warforged_Col_0428154152_texture_fbx"
  "crimson_sentinel|Blood Eagle|Meshy_AI_Crimson_Sentinel_0428154345_texture_fbx"
  "crimson_titan|Blood Eagle|Meshy_AI_Crimson_Titan_0428154522_texture_fbx"
  "aegis_sentinel|Diamond sword|Meshy_AI_Aegis_Sentinel_0428155011_texture_fbx"
  "obsidian_vanguard|Diamond sword|Meshy_AI_Obsidian_Vanguard_0428155025_texture_fbx"
  "midnight_sentinel|Diamond sword|Meshy_AI_Midnight_Sentinel_0428154955_texture_fbx"
  "golden_phoenix|Phoenix|Meshy_AI_Golden_Phoenix_Knight_0428155021_texture_fbx"
  "violet_phoenix|Phoenix|Meshy_AI_Violet_Phoenix_0428155042_texture_fbx"
  "auric_phoenix|Phoenix|Meshy_AI_Auric_Phoenix_Knight_0428155026_texture_fbx"
  "iron_wolf|Starwolf|Meshy_AI_Iron_Wolf_Juggernaut_0428140955_texture_fbx"
  "emerald_sentinel|Starwolf|Meshy_AI_Emerald_Neon_Sentinel_0428153745_texture_fbx"
  "neon_wolf|Starwolf|Meshy_AI_Neon_Wolf_Sentinel_0428153808_texture_fbx"
)

TOTAL=${#MODELS[@]}
DONE=0
FAILED=0

for entry in "${MODELS[@]}"; do
  IFS='|' read -r slug team prefix <<< "$entry"
  FBX_DIR="$MODELS_DIR/$team/$prefix/$prefix"
  
  echo ""
  echo "============================================================"
  echo "[$((DONE+1))/$TOTAL] Processing: $slug ($team)"
  echo "============================================================"
  
  if [ ! -d "$FBX_DIR" ]; then
    echo "ERROR: FBX directory not found: $FBX_DIR"
    FAILED=$((FAILED+1))
    DONE=$((DONE+1))
    continue
  fi
  
  $BLENDER --background --python "$SCRIPT" -- "$slug" "$FBX_DIR" "$OUTPUT" 2>&1 | grep -E "(Processing|Source|Decimating|Result|Exported|ERROR|DONE)"
  
  if [ $? -eq 0 ]; then
    echo "✓ $slug complete"
  else
    echo "✗ $slug FAILED"
    FAILED=$((FAILED+1))
  fi
  
  DONE=$((DONE+1))
done

echo ""
echo "============================================================"
echo "BATCH COMPLETE: $((DONE-FAILED))/$TOTAL succeeded, $FAILED failed"
echo "============================================================"
echo ""
echo "Output files:"
ls -lhS "$OUTPUT"/*.glb 2>/dev/null | head -40

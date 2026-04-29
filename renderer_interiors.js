// @ai-contract renderer_interiors.js
// PURPOSE: Interior shapes — load Tribes 1 .dis-extracted binary meshes,
//          parse geometry, apply material classification, place at canonical positions
// SERVES: Scale (authentic Tribes 1 architecture), Belonging (team-colored bases)
// DEPENDS_ON: three (global), registerModelCollision (passed via init)
// EXPOSES: init(deps), getGroup(), dispose()
// LIFECYCLE: init() once at start → getGroup() for traversal → dispose() on teardown
// NOTES: Extracted from renderer.js R32.233. Binary parser + material system + placement.
//   Coordinate convention: MIS (x, y, z-up) → world (x=mis_x, y=mis_z, z=-mis_y)
//   MIS rotation z-axis (yaw radians) → Three.js rotation.y = -mis_rot_z

import * as THREE from 'three';

// ---- State ----
let _interiorShapesGroup = null;

// ---- Public accessor ----
export function getGroup() { return _interiorShapesGroup; }

export async function init({ scene, registerModelCollision }) {
    try {
        const [blobRes, infoRes, canonRes, paletteRes] = await Promise.all([
            fetch('assets/maps/raindance/raindance_meshes.bin'),
            fetch('assets/maps/raindance/raindance_meshes.json'),
            fetch('assets/maps/raindance/canonical.json'),
            fetch('assets/maps/raindance/material_palette.json'),
        ]);
        if (!blobRes.ok || !infoRes.ok || !canonRes.ok) {
            console.warn('[R32.48] Interior shape assets missing; skipping');
            return;
        }
        const blob = await blobRes.arrayBuffer();
        const info = await infoRes.json();
        const canon = await canonRes.json();
        const palette = paletteRes.ok ? await paletteRes.json() : {};
        const defaultEntry = palette['_default'] || { color: [0.50, 0.48, 0.45], roughness: 0.75, metalness: 0.10, emissive: null };

        // R32.48: Palette lookup — match texture name (case-insensitive, strip .bmp)
        // then prefix match for numbered variants (e.g. ext_grey9 → ext_grey)
        function lookupPalette(texName) {
            const key = texName.toLowerCase().replace(/\.bmp$/i, '');
            if (palette[key]) return palette[key];
            // Prefix match: strip trailing digits
            const prefix = key.replace(/\d+$/, '');
            if (prefix !== key && palette[prefix]) return palette[prefix];
            return defaultEntry;
        }

        // Parse the binary blob. Format:
        //   u32 'RDMS', u32 version, u32 num_meshes
        //   per mesh: u8 nameLen, char[nameLen] name,
        //             u32 nVerts, f32[3*nVerts] positions,
        //             u32 nUVs, f32[2*nUVs] uvs,           (v2+)
        //             u32 nIndices, u32[nIndices] indices,
        //             u32 nTris, u8[nTris] material_indices (v2+)
        const dv = new DataView(blob);
        let off = 0;
        const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
        off = 4;
        if (magic !== 'RDMS') { console.warn('[R32.48] bad magic', magic); return; }
        const version = dv.getUint32(off, true); off += 4;
        const num = dv.getUint32(off, true); off += 4;
        console.log('[R32.48] Mesh blob version', version, '—', num, 'meshes');

        const meshes = new Map();
        for (let i = 0; i < num; i++) {
            const nameLen = dv.getUint8(off); off += 1;
            const nameBytes = new Uint8Array(blob, off, nameLen);
            const name = new TextDecoder('utf-8').decode(nameBytes);
            off += nameLen;
            const nVerts = dv.getUint32(off, true); off += 4;
            const positions = new Float32Array(blob.slice(off, off + nVerts * 12));
            off += nVerts * 12;

            let uvs = null, materialIndices = null;
            if (version >= 2) {
                const nUVs = dv.getUint32(off, true); off += 4;
                uvs = new Float32Array(blob.slice(off, off + nUVs * 8));
                off += nUVs * 8;
            }

            const nIdx = dv.getUint32(off, true); off += 4;
            const indices = new Uint32Array(blob.slice(off, off + nIdx * 4));
            off += nIdx * 4;

            if (version >= 2) {
                const nTris = dv.getUint32(off, true); off += 4;
                materialIndices = new Uint8Array(blob.slice(off, off + nTris));
                off += nTris;
            }

            meshes.set(name, { positions, indices, nVerts, uvs, materialIndices });
        }
        console.log('[R32.48] Loaded', meshes.size, 'unique interior-shape meshes');

        // Build a material name list lookup from sidecar JSON
        const meshMaterialNames = new Map();
        for (const m of (info.meshes || [])) {
            meshMaterialNames.set(m.fileName, m.materials || []);
        }

        // R32.48: Per-mesh material using geometry groups from the material palette.
        // Each unique material index gets its own PBR material (color, roughness, metalness, emissive).
        // R32.48.1: polygonOffset prevents z-fighting on thin/coplanar surfaces with DoubleSide.
        const _matProps = {
            side: THREE.FrontSide, flatShading: true, vertexColors: false,  // R32.64.2: REVERTED — flatShading OFF caused black flashing
            polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        };

        // R32.66: Procedural texture generator — runtime canvas textures by material category
        const _texCache = new Map();
        const _SZ = 128;
        function _noise(ctx,w,h,r,g,b,a,spread){
            const id=ctx.getImageData(0,0,w,h),d=id.data;
            for(let i=0;i<d.length;i+=4){
                const n=(Math.random()-0.5)*spread;
                d[i]=Math.max(0,Math.min(255,r+n));
                d[i+1]=Math.max(0,Math.min(255,g+n));
                d[i+2]=Math.max(0,Math.min(255,b+n));
                d[i+3]=a;
            }
            ctx.putImageData(id,0,0);
        }
        function _genProceduralTex(texName, baseColor) {
            const key = texName.toLowerCase().replace(/\.bmp$/i,'');
            if (_texCache.has(key)) return _texCache.get(key);
            const c = document.createElement('canvas');
            c.width = c.height = _SZ;
            const ctx = c.getContext('2d');
            const [cr,cg,cb] = [baseColor[0]*255|0, baseColor[1]*255|0, baseColor[2]*255|0];
            // Classify by name prefix
            if (key.startsWith('ext_iron') || key === 'itube' || key === 'ivent') {
                // Dark iron — brushed metal + scratches
                _noise(ctx,_SZ,_SZ,cr,cg,cb,255,30);
                ctx.strokeStyle='rgba(255,255,255,0.06)';
                for(let i=0;i<60;i++){ctx.beginPath();const y=Math.random()*_SZ;ctx.moveTo(0,y);ctx.lineTo(_SZ,y+(Math.random()-0.5)*4);ctx.stroke();}
                ctx.strokeStyle='rgba(0,0,0,0.15)';
                for(let i=0;i<8;i++){ctx.beginPath();const y=Math.random()*_SZ;ctx.moveTo(Math.random()*_SZ,y);ctx.lineTo(Math.random()*_SZ,y+(Math.random()-0.5)*6);ctx.lineWidth=1+Math.random();ctx.stroke();}
            } else if (key.startsWith('metal_') || key === 'base_metal' || key === 'special_metal' || key === 'idkmetalstrip' || key === 'iltmetal' || key === 'greyrib') {
                // Light metal — fine brushed
                _noise(ctx,_SZ,_SZ,cr,cg,cb,255,20);
                ctx.strokeStyle='rgba(255,255,255,0.04)';
                for(let i=0;i<80;i++){ctx.beginPath();const y=Math.random()*_SZ;ctx.moveTo(0,y);ctx.lineTo(_SZ,y+(Math.random()-0.5)*2);ctx.stroke();}
                ctx.strokeStyle='rgba(200,200,210,0.08)';
                for(let i=0;i<3;i++){const y=Math.random()*_SZ;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(_SZ,y);ctx.lineWidth=0.5;ctx.stroke();}
            } else if (key.startsWith('ext_grey')) {
                // Concrete/composite — noise + panel seams
                _noise(ctx,_SZ,_SZ,cr,cg,cb,255,18);
                ctx.strokeStyle='rgba(0,0,0,0.12)';ctx.lineWidth=1;
                ctx.strokeRect(2,2,_SZ-4,_SZ-4);
                ctx.strokeStyle='rgba(0,0,0,0.06)';
                ctx.beginPath();ctx.moveTo(0,_SZ/2);ctx.lineTo(_SZ,_SZ/2);ctx.stroke();
                // subtle staining
                ctx.fillStyle='rgba(80,70,55,0.06)';
                for(let i=0;i<5;i++){ctx.beginPath();ctx.arc(Math.random()*_SZ,Math.random()*_SZ,8+Math.random()*15,0,Math.PI*2);ctx.fill();}
            } else if (key.startsWith('base_warm') || key.startsWith('warm_') || key === 'special_warm') {
                // Warm panels — noise + horizontal lines
                _noise(ctx,_SZ,_SZ,cr,cg,cb,255,15);
                ctx.strokeStyle='rgba(0,0,0,0.08)';ctx.lineWidth=0.5;
                for(let y=0;y<_SZ;y+=16){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(_SZ,y);ctx.stroke();}
                ctx.strokeStyle='rgba(255,255,255,0.04)';
                for(let y=8;y<_SZ;y+=16){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(_SZ,y);ctx.stroke();}
            } else if (key.startsWith('cold_') || key === 'base_cold') {
                // Cold panels — noise + grid
                _noise(ctx,_SZ,_SZ,cr,cg,cb,255,15);
                ctx.strokeStyle='rgba(0,0,0,0.07)';ctx.lineWidth=0.5;
                for(let y=0;y<_SZ;y+=32){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(_SZ,y);ctx.stroke();}
                for(let x=0;x<_SZ;x+=32){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,_SZ);ctx.stroke();}
            } else if (key === 'base_rock' || key.startsWith('ext_stone') || key.startsWith('lrrrr') || key === 'lcccc') {
                // Rock — mottled organic
                _noise(ctx,_SZ,_SZ,cr,cg,cb,255,35);
                ctx.fillStyle='rgba(70,90,50,0.08)';
                for(let i=0;i<12;i++){ctx.beginPath();ctx.arc(Math.random()*_SZ,Math.random()*_SZ,6+Math.random()*18,0,Math.PI*2);ctx.fill();}
                ctx.fillStyle='rgba(40,35,25,0.07)';
                for(let i=0;i<8;i++){ctx.beginPath();ctx.arc(Math.random()*_SZ,Math.random()*_SZ,4+Math.random()*12,0,Math.PI*2);ctx.fill();}
            } else if (key.startsWith('light_') || key === 'special_interface' || key === 'special_shield' || key === 'hdisplay_yellow' || key === 'redylight') {
                // Emissive — scan lines + glow
                ctx.fillStyle=`rgb(${cr},${cg},${cb})`;ctx.fillRect(0,0,_SZ,_SZ);
                ctx.fillStyle='rgba(255,255,255,0.1)';
                for(let y=0;y<_SZ;y+=4){ctx.fillRect(0,y,_SZ,1);}
                ctx.fillStyle='rgba(255,255,255,0.15)';ctx.fillRect(0,_SZ/2-2,_SZ,4);
            } else if (key.startsWith('base.emblem')) {
                // Team emblem — base color + diamond pattern
                ctx.fillStyle=`rgb(${cr},${cg},${cb})`;ctx.fillRect(0,0,_SZ,_SZ);
                ctx.strokeStyle='rgba(255,255,255,0.12)';ctx.lineWidth=1;
                const s=16;for(let y=-_SZ;y<_SZ*2;y+=s){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(_SZ,y+_SZ);ctx.stroke();ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(_SZ,y-_SZ);ctx.stroke();}
            } else if (key === 'carpet_base') {
                // Carpet — woven texture
                _noise(ctx,_SZ,_SZ,cr,cg,cb,255,12);
                ctx.strokeStyle='rgba(0,0,0,0.06)';ctx.lineWidth=0.5;
                for(let y=0;y<_SZ;y+=3){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(_SZ,y);ctx.stroke();}
                for(let x=0;x<_SZ;x+=3){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,_SZ);ctx.stroke();}
            } else {
                // Default — subtle noise
                _noise(ctx,_SZ,_SZ,cr,cg,cb,255,20);
            }
            const tex = new THREE.CanvasTexture(c);
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.repeat.set(2,2);
            tex.magFilter = THREE.LinearFilter;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            _texCache.set(key, tex);
            return tex;
        }

        // Cache of material arrays per mesh filename (since multiple instances share geometry)
        const matArrayCache = new Map();

        // R32.70: PBR texture system — CC0 textures from Poly Haven
        // Classify a material name into its PBR texture category
        function _classifyMaterial(texName) {
            const key = texName.toLowerCase().replace(/\.bmp$/i, '');
            if (key.startsWith('ext_iron') || key === 'itube' || key === 'ivent') return 'heavy_metal';
            if (key.startsWith('metal_') || key === 'base_metal' || key === 'special_metal' || key === 'idkmetalstrip' || key === 'iltmetal' || key === 'greyrib') return 'light_metal';
            if (key.startsWith('ext_grey')) return 'grey_exterior';
            if (key.startsWith('base_warm') || key.startsWith('warm_') || key === 'special_warm') return 'warm_panel';
            if (key.startsWith('cold_') || key === 'base_cold') return 'cold_panel';
            if (key === 'base_rock' || key.startsWith('ext_stone') || key.startsWith('lrrrr') || key === 'lcccc') return 'rock';
            if (key.startsWith('light_') || key === 'special_interface' || key === 'special_shield' || key === 'hdisplay_yellow' || key === 'redylight') return 'emissive';
            if (key.startsWith('base.emblem')) return 'team_emblem';
            if (key === 'carpet_base') return 'interior_detail';
            return 'accent';
        }

        // Pre-load PBR texture maps per category
        const _pbrTextures = new Map(); // category -> { albedo, normal, roughness }
        const _pbrCategories = ['heavy_metal', 'light_metal', 'grey_exterior', 'warm_panel', 'cold_panel', 'rock', 'interior_detail', 'accent'];
        const _pbrLoader = new THREE.TextureLoader();
        const _pbrBasePath = 'assets/textures/buildings/';
        let _pbrReady = false;

        // Load all PBR textures (non-blocking, materials fall back to procedural until loaded)
        const _pbrLoadPromises = [];
        for (const cat of _pbrCategories) {
            const catMaps = {};
            for (const mapType of ['albedo', 'normal', 'roughness']) {
                const url = _pbrBasePath + cat + '_' + mapType + '.png';
                const p = new Promise(resolve => {
                    _pbrLoader.load(url, tex => {
                        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                        tex.repeat.set(2, 2);
                        tex.magFilter = THREE.LinearFilter;
                        tex.minFilter = THREE.LinearMipmapLinearFilter;
                        tex.generateMipmaps = true;
                        tex.colorSpace = mapType === 'albedo' ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
                        catMaps[mapType] = tex;
                        resolve();
                    }, undefined, () => {
                        console.warn('[R32.70] Failed to load PBR texture:', url);
                        resolve(); // resolve anyway — graceful fallback
                    });
                });
                _pbrLoadPromises.push(p);
            }
            _pbrTextures.set(cat, catMaps);
        }
        Promise.all(_pbrLoadPromises).then(() => {
            _pbrReady = true;
            let loaded = 0;
            for (const [cat, maps] of _pbrTextures) {
                const count = Object.keys(maps).length;
                loaded += count;
            }
            console.log('[R32.70] PBR textures ready:', loaded, 'maps across', _pbrTextures.size, 'categories');
        });

        // R32.71: Team color definitions for building accents
        // Team 0 = Blood Eagle (red), Team 1 = Diamond Sword (blue)
        const _TEAM_EMBLEM_COLORS = {
            0: { color: [0.78, 0.19, 0.17], emissive: [0.43, 0.09, 0.07] },  // Blood Eagle red
            1: { color: [0.17, 0.35, 0.78], emissive: [0.07, 0.15, 0.43] },  // Diamond Sword blue
        };

        function buildMaterialArray(fileName, teamIdx) {
            const cacheKey = teamIdx >= 0 ? fileName + ':t' + teamIdx : fileName;
            if (matArrayCache.has(cacheKey)) return matArrayCache.get(cacheKey);
            const matNames = meshMaterialNames.get(fileName) || [];
            const mats = matNames.map(texName => {
                const entry = lookupPalette(texName);
                let [cr, cg, cb] = entry.color;
                const category = _classifyMaterial(texName);

                // R32.71: Override emblem colors based on building team ownership
                const isTeamEmblem = category === 'team_emblem';
                if (isTeamEmblem && teamIdx >= 0 && _TEAM_EMBLEM_COLORS[teamIdx]) {
                    [cr, cg, cb] = _TEAM_EMBLEM_COLORS[teamIdx].color;
                }

                const pbrMaps = _pbrTextures.get(category);
                const usePBR = pbrMaps && pbrMaps.albedo && category !== 'emissive' && category !== 'team_emblem';

                // R32.70: Use PBR albedo when available, procedural as fallback
                const albedoTex = usePBR ? pbrMaps.albedo : _genProceduralTex(
                    isTeamEmblem && teamIdx >= 0 ? texName + '_t' + teamIdx : texName,
                    [cr, cg, cb]
                );

                const mat = new THREE.MeshStandardMaterial({
                    ..._matProps,
                    // R32.70: Tint PBR albedo by palette color for variation; procedural textures already bake the color
                    color: usePBR ? new THREE.Color(cr, cg, cb) : new THREE.Color(1, 1, 1),
                    map: albedoTex,
                    roughness: entry.roughness,
                    metalness: isTeamEmblem ? 0.4 : entry.metalness,  // R32.71: slightly more metallic emblems
                    envMapIntensity: 0.35,
                });

                // R32.70: Apply normal + roughness maps from PBR set
                if (usePBR) {
                    if (pbrMaps.normal) {
                        mat.normalMap = pbrMaps.normal;
                        mat.normalScale = new THREE.Vector2(0.8, 0.8); // slightly subdued — T1 geometry is low-poly
                    }
                    if (pbrMaps.roughness) {
                        mat.roughnessMap = pbrMaps.roughness;
                    }
                }

                mat.userData.isInterior = true; // R32.53: skip toonification — toon step-lighting makes back-faces pure black
                // R32.71: Team emblem emissive glow for visibility
                if (isTeamEmblem && teamIdx >= 0 && _TEAM_EMBLEM_COLORS[teamIdx]) {
                    const te = _TEAM_EMBLEM_COLORS[teamIdx].emissive;
                    mat.emissive = new THREE.Color(te[0], te[1], te[2]);
                    mat.emissiveIntensity = 0.55;
                } else if (entry.emissive) {
                    mat.emissive = new THREE.Color(entry.emissive[0], entry.emissive[1], entry.emissive[2]);
                    mat.emissiveIntensity = 0.65;
                } else {
                    // Subtle ambient emissive for non-emissive materials
                    mat.emissive = new THREE.Color(cr * 0.08, cg * 0.08, cb * 0.08);
                    mat.emissiveIntensity = 0.30;
                }
                return mat;
            });
            // Fallback material for indices not covered by the DML list
            const fallback = new THREE.MeshStandardMaterial({
                ..._matProps,
                color: new THREE.Color(defaultEntry.color[0], defaultEntry.color[1], defaultEntry.color[2]),
                roughness: defaultEntry.roughness,
                metalness: defaultEntry.metalness,
                envMapIntensity: 0.35,
                emissive: new THREE.Color(0x1a1814),
                emissiveIntensity: 0.30,
            });
            fallback.userData.isInterior = true; // R32.53: skip toonification
            matArrayCache.set(cacheKey, { mats, fallback });
            return { mats, fallback };
        }

        // Create a parent group for easy hide/show + selective culling
        _interiorShapesGroup = new THREE.Group();
        _interiorShapesGroup.name = 'RaindanceInteriorShapes';
        scene.add(_interiorShapesGroup);

        // Helper: convert MIS position to world
        const toWorld = (mp) => ({ x: mp[0], y: mp[2], z: -mp[1] });

        // Build BufferGeometry once per unique fileName, reuse across instances.
        // Tribes 1 used DirectX-style left-handed coords with CW winding; Three.js
        // is right-handed with CCW winding. We flip the index winding (i,j,k)->(i,k,j)
        // so face normals computed by computeCreaseNormals point outward.
        // R32.46: crease-aware smooth normals + midpoint subdivision for rocks
        // R32.48: material-palette vertex colors + geometry groups
        const geomCache = new Map();
        const _t0 = performance.now();
        let _enhancedCount = 0;
        const getGeom = (fileName) => {
            if (geomCache.has(fileName)) return geomCache.get(fileName);
            const m = meshes.get(fileName);
            if (!m) return null;

            const matNames = meshMaterialNames.get(fileName) || [];
            const hasV2Materials = m.materialIndices && matNames.length > 0;

            // Flip winding from CW (DirectX) to CCW (Three.js)
            const nTris = m.indices.length / 3;
            const flipped = new Uint32Array(m.indices.length);
            for (let t = 0; t < m.indices.length; t += 3) {
                flipped[t]   = m.indices[t];
                flipped[t+1] = m.indices[t+2];
                flipped[t+2] = m.indices[t+1];
            }

            // Per-triangle material index array (parallel to triangles after flip)
            let matIndices = m.materialIndices ? Array.from(m.materialIndices) : null;

            let finalPositions = m.positions;
            let finalIndices = flipped;

            // R32.46: Midpoint subdivision for rocks — adds resolution so
            // crease normals have more geometry to smooth with
            const isRock = fileName.toLowerCase().startsWith('lrock');
            if (isRock) {
                const sub = midpointSubdivide(finalPositions, finalIndices, matIndices);
                finalPositions = sub.positions;
                finalIndices = sub.indices;
                if (sub.triData) matIndices = sub.triData;
            }

            // R32.48: Build per-triangle material color array from palette
            let materialColors = null;
            let groupInfo = null; // { groups: [{matIdx, start, count}], uniqueMatIndices: [] }
            if (hasV2Materials && matIndices) {
                const finalNTris = finalIndices.length / 3;

                // Sort triangles by material index for contiguous groups
                const triOrder = Array.from({ length: finalNTris }, (_, i) => i);
                triOrder.sort((a, b) => (matIndices[a] || 0) - (matIndices[b] || 0));

                // Reorder indices and material indices according to sort
                const sortedIndices = new Uint32Array(finalIndices.length);
                const sortedMatIndices = new Array(finalNTris);
                for (let i = 0; i < finalNTris; i++) {
                    const src = triOrder[i];
                    sortedIndices[i * 3]     = finalIndices[src * 3];
                    sortedIndices[i * 3 + 1] = finalIndices[src * 3 + 1];
                    sortedIndices[i * 3 + 2] = finalIndices[src * 3 + 2];
                    sortedMatIndices[i] = matIndices[src] || 0;
                }
                finalIndices = sortedIndices;

                // R32.48.1: With geometry groups, each group gets its own material
                // whose .color already encodes the palette color. Vertex colors are
                // multiplied with material.color, so we set them to WHITE (1,1,1)
                // to avoid double-multiplication (palette × palette = too dark).
                materialColors = new Float32Array(finalNTris * 3);
                for (let t = 0; t < finalNTris; t++) {
                    materialColors[t * 3]     = 1.0;
                    materialColors[t * 3 + 1] = 1.0;
                    materialColors[t * 3 + 2] = 1.0;
                }

                // Build group boundaries
                const groups = [];
                let groupStart = 0;
                let prevMat = sortedMatIndices[0];
                for (let t = 1; t <= finalNTris; t++) {
                    const curMat = t < finalNTris ? sortedMatIndices[t] : -1;
                    if (curMat !== prevMat) {
                        groups.push({ matIdx: prevMat, start: groupStart * 3, count: (t - groupStart) * 3 });
                        groupStart = t;
                        prevMat = curMat;
                    }
                }
                groupInfo = groups;
            }

            // Build indexed geometry first (needed for crease normal computation)
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(finalPositions, 3));
            g.setIndex(new THREE.BufferAttribute(finalIndices, 1));

            // R32.46: Crease-aware smooth normals — 40° for architectural meshes,
            // 55° for rocks (rounder surfaces benefit from wider averaging)
            // R32.48: Pass materialColors for palette-based vertex coloring
            const creaseAngle = isRock ? 55 : 40;
            const enhanced = computeCreaseNormals(g, creaseAngle, materialColors);

            // R32.56.1: Normal attribute is unused — flatShading:true computes face
            // normals from screen-space derivatives (dFdx/dFdy), bypassing the broken
            // normals produced by computeCreaseNormals after the winding flip.
            // The R32.55 negation is removed; it had no effect with flatShading.

            // R32.48: Apply geometry groups for multi-material rendering.
            // After crease normals, geometry is non-indexed: each triangle = 3 consecutive verts.
            // Groups reference vertex offsets, so group.start = triStart * 3, count = triCount * 3.
            if (groupInfo && groupInfo.length > 0) {
                enhanced.clearGroups();
                for (let gi = 0; gi < groupInfo.length; gi++) {
                    const grp = groupInfo[gi];
                    enhanced.addGroup(grp.start, grp.count, grp.matIdx);
                }
            }

            _enhancedCount++;
            geomCache.set(fileName, enhanced);
            return enhanced;
        };

        // Place every neutral_interior_shapes instance.
        // Use a Group-wrapper-per-instance so we can apply yaw (around world Y)
        // INDEPENDENTLY from the local Tribes-z-up to Three-y-up rotation.
        // R32.71: Determine team ownership per shape by proximity to team generators.
        let _teamMidY = 318; // default midpoint
        try {
            const t0gens = (canon.team0?.static_shapes || []).filter(s => s.datablock === 'Generator');
            const t1gens = (canon.team1?.static_shapes || []).filter(s => s.datablock === 'Generator');
            if (t0gens.length && t1gens.length) {
                _teamMidY = (t0gens[0].position[1] + t1gens[0].position[1]) / 2;
            }
        } catch (e) { /* keep default */ }

        let placed = 0, missed = 0;
        const items = (canon.neutral_interior_shapes || []);
        for (const item of items) {
            const geom = getGeom(item.fileName);
            if (!geom) { missed++; continue; }

            // R32.71: Assign team by Y position (Tribes coords).
            // Rocks and midfield structures get -1 (neutral, no team coloring).
            const isRock = item.fileName.toLowerCase().startsWith('lrock');
            const isMidfield = item.fileName.toLowerCase().startsWith('mis_ob') ||
                               item.fileName.toLowerCase().startsWith('expbridge');
            const shapeTeamIdx = (isRock || isMidfield) ? -1 : (item.position[1] < _teamMidY ? 0 : 1);

            // R32.48: build material array for this mesh, with team coloring
            const { mats, fallback } = buildMaterialArray(item.fileName, shapeTeamIdx);
            // Create material array indexed by material slot.
            // Geometry groups reference matIdx (the DML material index).
            // Build a sparse array: slot i = mats[i] if exists, else fallback.
            const maxSlot = Math.max(mats.length - 1, ...(geom.groups || []).map(g => g.materialIndex));
            const matArray = [];
            for (let i = 0; i <= maxSlot; i++) {
                matArray.push(i < mats.length ? mats[i] : fallback);
            }

            const mesh = new THREE.Mesh(geom, matArray.length > 1 ? matArray : (matArray[0] || fallback));
            // Inner: rotate -90deg around X to map Tribes local-z-up to Three y-up
            mesh.rotation.x = -Math.PI / 2;
            mesh.castShadow = false;  // R32.49: interior self-shadowing with DoubleSide causes black rectangle flicker
            mesh.receiveShadow = false; // R32.50: interiors are enclosed; sun shadows inside cause flicker
            mesh.frustumCulled = false; // mirror existing buildings policy
            // Outer group: positions in world, applies yaw around world Y
            const outer = new THREE.Group();
            const w = toWorld(item.position);
            outer.position.set(w.x, w.y, w.z);
            // R32.69: Full 3-axis rotation from MIS data.
            // Tribes uses Z-up left-handed rotation convention.
            // Convert: Tribes axis (X,Y,Z) → Three.js axis (X,-Z,Y), negate angles for LH→RH.
            const _rx = item.rotation?.[0] || 0;
            const _ry = item.rotation?.[1] || 0;
            const _rz = item.rotation?.[2] || 0;
            if (_rx === 0 && _ry === 0) {
                outer.rotation.y = -_rz;  // Fast path: yaw-only shapes (most buildings)
            } else {
                // Full 3-axis rotation for tilted shapes (rocks, etc.)
                const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -_rx);
                const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), -_ry);
                const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -_rz);
                outer.quaternion.copy(qz.multiply(qy).multiply(qx));
            }
            outer.add(mesh);
            outer.userData = { fileName: item.fileName, isInterior: true, teamIdx: shapeTeamIdx };
            _interiorShapesGroup.add(outer);
            placed++;
        }
        console.log('[R32.48] Interior shapes placed:', placed, '(missed', missed, ')');
        // R32.71: Log team assignment summary
        const t0count = items.filter(i => !i.fileName.toLowerCase().startsWith('lrock') &&
            !i.fileName.toLowerCase().startsWith('mis_ob') &&
            !i.fileName.toLowerCase().startsWith('expbridge') &&
            i.position[1] < _teamMidY).length;
        const t1count = items.filter(i => !i.fileName.toLowerCase().startsWith('lrock') &&
            !i.fileName.toLowerCase().startsWith('mis_ob') &&
            !i.fileName.toLowerCase().startsWith('expbridge') &&
            i.position[1] >= _teamMidY).length;
        console.log('[R32.71] Team-colored accents: team0(BE)=' + t0count + ' team1(DS)=' + t1count + ' neutral=' + (items.length - t0count - t1count));
        console.log('[R32.48] Geometry enhancement:', (performance.now() - _t0).toFixed(1) + 'ms for',
            _enhancedCount, 'unique meshes (crease normals + rock subdivision + material palette)');

        // R32.54 DIAGNOSTIC URL params — no console commands needed
        {
            const _dp = new URLSearchParams(window.location.search);
            if (_dp.has('hideInterior')) {
                console.log('[R32.54-DIAG] hideInterior: RaindanceInteriorShapes.visible = false');
                _interiorShapesGroup.visible = false;
            }
            if (_dp.has('basicInterior')) {
                let meshCount = 0;
                _interiorShapesGroup.traverse(obj => {
                    if (!obj.isMesh) return;
                    meshCount++;
                    const bright = new THREE.MeshBasicMaterial({ color: 0xff4444, side: THREE.DoubleSide });
                    if (Array.isArray(obj.material)) {
                        obj.material = obj.material.map(() => bright);
                    } else {
                        obj.material = bright;
                    }
                });
                console.log('[R32.54-DIAG] basicInterior: replaced', meshCount, 'meshes with red MeshBasicMaterial');
            }
        }

        // R32.99: Unified collision — use registerModelCollision() for all geometry.
        // The Three.js meshes already have correct world transforms via parent chain:
        // scene → _interiorShapesGroup → outer(worldPos+rot) → mesh(-90°X)
        // Force matrixWorld update since collision registers before first render.
        _interiorShapesGroup.updateMatrixWorld(true);
        const colInfo = registerModelCollision(_interiorShapesGroup);
        console.log('[R32.99] Interior collision via registerModelCollision:', colInfo);
    } catch (e) {
        console.error('[R32.1] initInteriorShapes failed', e);
    }
}

// ---- Cleanup ----
export function dispose() {
    if (_interiorShapesGroup) {
        _interiorShapesGroup.traverse(child => {
            if (child.isMesh) {
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach(m => m.dispose());
                    } else {
                        child.material.dispose();
                    }
                }
            }
        });
        if (_interiorShapesGroup.parent) _interiorShapesGroup.parent.remove(_interiorShapesGroup);
        _interiorShapesGroup = null;
    }
}

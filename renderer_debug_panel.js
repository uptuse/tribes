// renderer_debug_panel.js — R32.56
// Toggle panel for isolating the interior shapes black rectangle bug.
// Load with ?debugPanel in URL. Press F8 to show/hide.
(function() {
    'use strict';
    const params = new URLSearchParams(window.location.search);
    if (!params.has('debugPanel')) return;

    // Wait for renderer to expose its internals
    function waitForScene(cb) {
        const check = () => {
            if (window._tribesDebug && window._tribesDebug.scene) cb(window._tribesDebug);
            else setTimeout(check, 200);
        };
        check();
    }

    waitForScene(function(dbg) {
        const { scene, renderer, composer } = dbg;

        // Cache references
        const interiorGroup = scene.getObjectByName('RaindanceInteriorShapes');
        const buildingMeshes = [];
        scene.children.forEach(c => {
            if (c.userData && c.userData.canon !== undefined) buildingMeshes.push(c);
            // Also catch fallback buildings (type in userData)
            if (c.isMesh && c.userData && typeof c.userData === 'object' && !c.userData.isInterior && c.geometry && c.geometry.type === 'BoxGeometry') buildingMeshes.push(c);
        });

        // Store original materials for interior shapes
        const origMats = new Map();
        if (interiorGroup) {
            interiorGroup.traverse(obj => {
                if (obj.isMesh) origMats.set(obj, Array.isArray(obj.material) ? obj.material.slice() : obj.material);
            });
        }

        // Build panel HTML
        const panel = document.createElement('div');
        panel.id = 'debug-panel';
        panel.style.cssText = 'position:fixed;top:60px;right:10px;z-index:99999;background:rgba(0,0,0,0.9);color:#eee;font:12px/1.6 monospace;padding:12px 16px;border-radius:8px;border:1px solid #444;max-height:80vh;overflow-y:auto;min-width:260px;';

        const title = document.createElement('div');
        title.style.cssText = 'font-size:14px;font-weight:bold;margin-bottom:8px;color:#FFC850;';
        title.textContent = '🔧 Interior Debug Panel';
        panel.appendChild(title);

        const checks = [
            { id: 'interior-visible',    label: 'Interior Shapes visible',     default: true },
            { id: 'buildings-visible',   label: 'Procedural Buildings visible', default: true },
            { id: 'mat-standard',        label: 'Material: MeshStandardMaterial', default: true, group: 'mat' },
            { id: 'mat-basic',           label: 'Material: MeshBasicMaterial',    default: false, group: 'mat' },
            { id: 'mat-lambert',         label: 'Material: MeshLambertMaterial',  default: false, group: 'mat' },
            { id: 'mat-phong',           label: 'Material: MeshPhongMaterial',    default: false, group: 'mat' },
            { id: 'flat-shading',        label: 'Flat Shading',                default: true },
            { id: 'double-side',         label: 'DoubleSide (vs FrontSide)',   default: false },
            { id: 'vertex-colors',       label: 'Vertex Colors',              default: false },
            { id: 'polygon-offset',      label: 'Polygon Offset',             default: true },
            { id: 'negate-normals',      label: 'Negate Normals',             default: true },
            { id: 'cast-shadow',         label: 'Cast Shadow',                default: false },
            { id: 'receive-shadow',      label: 'Receive Shadow',             default: false },
            { id: 'toonify-skip',        label: 'Skip Toonify (isInterior)',  default: true },
            { id: 'postprocess',         label: 'Post-processing (composer)', default: true },
            { id: 'freeze-daynight',     label: 'Freeze Day/Night at noon',   default: false },
        ];

        const state = {};
        checks.forEach(c => { state[c.id] = c.default; });

        function rebuildMaterials() {
            if (!interiorGroup) return;
            interiorGroup.traverse(obj => {
                if (!obj.isMesh) return;
                const orig = origMats.get(obj);
                if (!orig) return;

                // Determine material type
                let MatClass = THREE.MeshStandardMaterial;
                if (state['mat-basic']) MatClass = THREE.MeshBasicMaterial;
                else if (state['mat-lambert']) MatClass = THREE.MeshLambertMaterial;
                else if (state['mat-phong']) MatClass = THREE.MeshPhongMaterial;

                const side = state['double-side'] ? THREE.DoubleSide : THREE.FrontSide;

                function makeMat(srcMat) {
                    const props = {
                        color: srcMat.color ? srcMat.color.clone() : new THREE.Color(0x888888),
                        side: side,
                        flatShading: state['flat-shading'],
                        vertexColors: state['vertex-colors'],
                        polygonOffset: state['polygon-offset'],
                        polygonOffsetFactor: state['polygon-offset'] ? 1 : 0,
                        polygonOffsetUnits: state['polygon-offset'] ? 1 : 0,
                    };
                    if (MatClass !== THREE.MeshBasicMaterial) {
                        props.emissive = srcMat.emissive ? srcMat.emissive.clone() : new THREE.Color(0x000000);
                        props.emissiveIntensity = srcMat.emissiveIntensity || 0;
                    }
                    if (MatClass === THREE.MeshStandardMaterial) {
                        props.roughness = srcMat.roughness || 0.7;
                        props.metalness = srcMat.metalness || 0.1;
                        props.envMapIntensity = srcMat.envMapIntensity || 0.35;
                    }
                    if (MatClass === THREE.MeshPhongMaterial) {
                        props.shininess = 30;
                    }
                    const m = new MatClass(props);
                    if (state['toonify-skip']) m.userData.isInterior = true;
                    return m;
                }

                if (Array.isArray(orig)) {
                    obj.material = orig.map(m => makeMat(m));
                } else {
                    obj.material = makeMat(orig);
                }

                obj.castShadow = state['cast-shadow'];
                obj.receiveShadow = state['receive-shadow'];
            });

            // Handle normal negation
            if (interiorGroup) {
                interiorGroup.traverse(obj => {
                    if (!obj.isMesh || !obj.geometry) return;
                    const nrm = obj.geometry.getAttribute('normal');
                    if (!nrm) return;
                    // We track whether normals are currently negated via userData
                    const isNeg = obj.userData._normalsNegated || false;
                    const wantNeg = state['negate-normals'];
                    if (isNeg !== wantNeg) {
                        for (let i = 0; i < nrm.array.length; i++) nrm.array[i] *= -1;
                        nrm.needsUpdate = true;
                        obj.userData._normalsNegated = wantNeg;
                    }
                });
            }
        }

        function applyState() {
            // Visibility
            if (interiorGroup) interiorGroup.visible = state['interior-visible'];
            buildingMeshes.forEach(m => { m.visible = state['buildings-visible']; });

            // Post-processing
            if (dbg.setComposerEnabled) dbg.setComposerEnabled(state['postprocess']);

            // Day/night freeze
            if (window.DayNight && window.DayNight.freeze) {
                if (state['freeze-daynight']) window.DayNight.freeze(12);
                else window.DayNight.unfreeze();
            }

            rebuildMaterials();
        }

        // Build UI
        let lastGroup = null;
        checks.forEach(c => {
            if (c.group && c.group === 'mat' && c.id !== 'mat-standard') {
                // Radio-style for material group — just indent
            }
            const row = document.createElement('label');
            row.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;padding:2px 0;';
            if (c.group) row.style.paddingLeft = '12px';

            const input = document.createElement('input');
            input.type = c.group ? 'radio' : 'checkbox';
            if (c.group) {
                input.name = c.group;
                input.checked = c.default;
            } else {
                input.checked = c.default;
            }
            input.style.cssText = 'margin:0;cursor:pointer;';

            input.addEventListener('change', () => {
                if (c.group) {
                    // Uncheck all in group, check this one
                    checks.filter(x => x.group === c.group).forEach(x => { state[x.id] = false; });
                    state[c.id] = true;
                } else {
                    state[c.id] = input.checked;
                }
                applyState();
            });

            const span = document.createElement('span');
            span.textContent = c.label;
            row.appendChild(input);
            row.appendChild(span);
            panel.appendChild(row);
        });

        // Status line
        const status = document.createElement('div');
        status.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid #444;color:#888;font-size:11px;';
        status.textContent = 'Toggle options and watch for changes. F8 to hide/show.';
        panel.appendChild(status);

        document.body.appendChild(panel);

        // F8 toggle
        window.addEventListener('keydown', e => {
            if (e.key === 'F8') {
                panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
                e.preventDefault();
            }
        });

        // Initial apply
        applyState();

        console.log('[R32.56] Debug panel ready — F8 to toggle, checkboxes to isolate');
    });
})();

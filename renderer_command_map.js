// renderer_command_map.js — R32.17-manus
// =============================================================================
// Tribes-style Command Map ("Tactical Map" / "Command Circuit").
//
// Bound to the C key. Toggles a full-screen translucent overhead view of the
// battlefield with hill-shaded terrain, all soldiers (team-colored), both
// flags, structures, and the local player's aim cone.
//
// v1 is read-only. Command-issuing layer (click-to-order) is deferred to v2,
// which will need C++ AI hooks.
// =============================================================================

(function() {
    'use strict';

    if (window.DEBUG_LOGS) console.log('[CommandMap] module loading…');

    // -------------------------------------------------------------------------
    // Module state
    // -------------------------------------------------------------------------
    const STATE = {
        active: false,
        canvas: null,
        ctx: null,
        // Cached hillshaded terrain background (re-rendered only when canvas size
        // changes — terrain itself is static for the match).
        terrainCanvas: null,
        terrainCanvasSize: 0,
        // Cached terrain bounds in world coords (centered on origin).
        worldHalfExtent: 1024,
        // Hooks supplied by renderer.js
        hooks: null,
        // Frame counter (used for animated dot pulses)
        tick: 0,
        // Settings
        teamColors: ['#3FA8FF', '#FF6A4A', '#9DDCFF'], // team 0=blue, team 1=red, fallback
    };

    // -------------------------------------------------------------------------
    // EARLY: bind the C key + create a stub canvas at IIFE time so the toggle
    // works even if init() never runs (e.g. if a hook getter throws).
    // -------------------------------------------------------------------------
    function _earlyBootstrap() {
        if (STATE.canvas) return;
        const c = document.createElement('canvas');
        c.id = 'cmd-map-canvas';
        c.style.cssText = [
            'position:fixed', 'inset:0',
            'width:100%', 'height:100%',
            'z-index:99999',                       // R32.17.3: above all HUD layers
            'display:none',
            'pointer-events:none',
            'background:rgba(2,8,16,0.85)',
            'backdrop-filter:blur(3px)',
            '-webkit-backdrop-filter:blur(3px)',
        ].join(';') + ';';
        document.body.appendChild(c);
        STATE.canvas = c;
        STATE.ctx = c.getContext('2d');

        window.addEventListener('keydown', _onKeyDown, true);
        window.addEventListener('resize', _onResize);
        _onResize();
        if (window.DEBUG_LOGS) console.log('[CommandMap] early bootstrap complete — C key bound');
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _earlyBootstrap);
    } else {
        _earlyBootstrap();
    }

    // -------------------------------------------------------------------------
    // Public API: call this once after renderer init has data views ready.
    // hooks = {
    //   getHeightmap: () => ({data: Float32Array, size: int, scale: float}),
    //   getPlayerView: () => ({view: Float32Array, stride: int, count: int}),
    //   getLocalIdx: () => int,
    //   getFlagView:   () => ({view: Float32Array, stride: int}),
    //   getBuildings:  () => Array<{mesh, type}>,
    // }
    // -------------------------------------------------------------------------
    function init(hooks) {
        STATE.hooks = hooks;
        _earlyBootstrap(); // idempotent
        if (window.DEBUG_LOGS) console.log('[R32.17] Command Map hooks wired — press C to toggle');
    }

    function _onResize() {
        if (!STATE.canvas) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = window.innerWidth;
        const h = window.innerHeight;
        STATE.canvas.width  = Math.floor(w * dpr);
        STATE.canvas.height = Math.floor(h * dpr);
        STATE.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Invalidate terrain cache so it re-renders at new size
        STATE.terrainCanvas = null;
    }

    function _onKeyDown(e) {
        // Only respond to bare C (not Ctrl-C, not while typing in an input)
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        const isC = (e.key === 'c' || e.key === 'C' || e.code === 'KeyC');
        if (isC) {
            e.preventDefault();
            e.stopPropagation();
            if (window.DEBUG_LOGS) console.log('[CommandMap] C pressed — toggling (was ' + (STATE.active ? 'open' : 'closed') + ')');
            toggle();
        } else if (e.key === 'Escape' && STATE.active) {
            e.preventDefault();
            close();
        }
    }

    function toggle() { STATE.active ? close() : open(); }
    function open()   {
        STATE.active = true;
        STATE.canvas.style.display = 'block';
        if (window.DEBUG_LOGS) console.log('[CommandMap] open: canvas display=' + STATE.canvas.style.display +
                    ', size=' + STATE.canvas.width + 'x' + STATE.canvas.height +
                    ', z=' + STATE.canvas.style.zIndex);
        _startSelfLoop();
    }
    function close()  { STATE.active = false; STATE.canvas.style.display = 'none';  }

    // R32.17.3: Self-driven render loop — don't depend on renderer.js calling update().
    let _selfRafActive = false;
    function _startSelfLoop() {
        if (_selfRafActive) return;
        _selfRafActive = true;
        function _raf() {
            if (!STATE.active) { _selfRafActive = false; return; }
            try { update(); } catch (e) { console.warn('[CommandMap] update error:', e); }
            requestAnimationFrame(_raf);
        }
        requestAnimationFrame(_raf);
    }

    // -------------------------------------------------------------------------
    // Terrain hillshade — sample heightmap, render as offscreen canvas, cache
    // -------------------------------------------------------------------------
    function _renderTerrainBackground() {
        const hm = STATE.hooks.getHeightmap();
        if (!hm || !hm.data || hm.size < 2) return;

        const w = window.innerWidth;
        const h = window.innerHeight;
        const mapSize = Math.min(w, h) * 0.85;          // map fills 85% of shorter axis
        const off = document.createElement('canvas');
        off.width = Math.floor(mapSize);
        off.height = Math.floor(mapSize);
        const octx = off.getContext('2d');

        const img = octx.createImageData(off.width, off.height);
        const N = hm.size;
        const data = hm.data;

        // Heightmap stats for normalization
        let hmin = Infinity, hmax = -Infinity;
        for (let i = 0; i < data.length; i++) {
            const v = data[i];
            if (v < hmin) hmin = v;
            if (v > hmax) hmax = v;
        }
        const hrange = Math.max(1, hmax - hmin);

        // Sun direction for hillshade (top-left)
        const sunDx = -0.7, sunDz = -0.7, sunDy = 0.6;
        const sunLen = Math.hypot(sunDx, sunDz, sunDy);
        const sx = sunDx / sunLen, sy = sunDy / sunLen, sz = sunDz / sunLen;

        for (let y = 0; y < off.height; y++) {
            // Map screen Y -> heightmap row.
            // Note: in world space, +Z is "south"; we want north-up like a real
            // tactical map, so we flip Y on the heightmap.
            const v = 1 - (y / (off.height - 1));
            const gz = v * (N - 1);
            const iz = Math.max(0, Math.min(N - 2, Math.floor(gz)));
            const fz = gz - iz;

            for (let x = 0; x < off.width; x++) {
                const u = x / (off.width - 1);
                const gx = u * (N - 1);
                const ix = Math.max(0, Math.min(N - 2, Math.floor(gx)));
                const fx = gx - ix;

                // Bilinear sample
                const h00 = data[iz       * N + ix    ];
                const h10 = data[iz       * N + (ix+1)];
                const h01 = data[(iz+1)   * N + ix    ];
                const h11 = data[(iz+1)   * N + (ix+1)];
                const hL = h00 * (1-fx) + h10 * fx;
                const hH = h01 * (1-fx) + h11 * fx;
                const elev = hL * (1-fz) + hH * fz;

                // Slope estimate (2-tap finite diff)
                const dHdx = (h10 - h00);
                const dHdz = (h01 - h00);

                // Normal = (-dHdx, 1, -dHdz) normalized
                const nLen = Math.hypot(dHdx, 1, dHdz);
                const nx = -dHdx / nLen;
                const ny = 1     / nLen;
                const nz = -dHdz / nLen;

                // Diffuse term
                const dot = Math.max(0, nx * sx + ny * sy + nz * sz);
                const shade = 0.35 + 0.65 * dot;

                // Elevation-banded base color (dark sea -> grass -> rock -> snow)
                const t = (elev - hmin) / hrange;
                let r, g, b;
                if (t < 0.18)        { r = 18;  g = 30;  b = 52; }   // basin
                else if (t < 0.45)   { r = 40;  g = 64;  b = 38; }   // grassland
                else if (t < 0.70)   { r = 78;  g = 78;  b = 60; }   // hills
                else if (t < 0.88)   { r = 102; g = 92;  b = 78; }   // upper hills
                else                 { r = 180; g = 184; b = 196; }  // peaks

                // Apply hillshade
                r = Math.min(255, Math.floor(r * shade * 1.4));
                g = Math.min(255, Math.floor(g * shade * 1.4));
                b = Math.min(255, Math.floor(b * shade * 1.4));

                const idx = (y * off.width + x) * 4;
                img.data[idx    ] = r;
                img.data[idx + 1] = g;
                img.data[idx + 2] = b;
                img.data[idx + 3] = 255;
            }
        }
        octx.putImageData(img, 0, 0);

        // Faint contour grid
        octx.strokeStyle = 'rgba(180,200,220,0.10)';
        octx.lineWidth = 1;
        const gridStep = off.width / 16;
        octx.beginPath();
        for (let i = 1; i < 16; i++) {
            octx.moveTo(i * gridStep, 0);
            octx.lineTo(i * gridStep, off.height);
            octx.moveTo(0, i * gridStep);
            octx.lineTo(off.width, i * gridStep);
        }
        octx.stroke();

        STATE.terrainCanvas = off;
        STATE.terrainCanvasSize = mapSize;
        // Compute world half-extent from heightmap for projection
        STATE.worldHalfExtent = (hm.size - 1) * hm.scale * 0.5;
    }

    // -------------------------------------------------------------------------
    // World -> screen projection (centered map area)
    // -------------------------------------------------------------------------
    function _worldToMap(wx, wz) {
        const w = window.innerWidth;
        const h = window.innerHeight;
        const size = STATE.terrainCanvasSize;
        const cx = w * 0.5;
        const cy = h * 0.5;
        const half = STATE.worldHalfExtent;
        const u = (wx + half) / (2 * half);
        // North-up: invert Z so +Z (south) is on screen-bottom
        const v = 1 - (wz + half) / (2 * half);
        return {
            x: cx - size * 0.5 + u * size,
            y: cy - size * 0.5 + v * size,
        };
    }

    // -------------------------------------------------------------------------
    // Per-frame draw — called from renderer.js loop
    // -------------------------------------------------------------------------
    function update() {
        if (!STATE.active || !STATE.canvas) return;
        STATE.tick++;
        // If hooks haven't been wired yet, draw a placeholder so user knows the
        // overlay opened (instead of silently rendering nothing).
        if (!STATE.hooks) {
            const ctx = STATE.ctx;
            ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
            ctx.fillStyle = '#FFC850';
            ctx.font = 'bold 24px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('COMMAND MAP — waiting for renderer hooks…',
                         window.innerWidth / 2, window.innerHeight / 2);
            return;
        }

        const ctx = STATE.ctx;
        const w = window.innerWidth;
        const h = window.innerHeight;

        // Clear to translucent black (the canvas style already provides the
        // backdrop blur; we just clear pixels for redraw)
        ctx.clearRect(0, 0, w, h);

        // 1) Terrain hillshade (cached)
        if (!STATE.terrainCanvas) _renderTerrainBackground();
        if (STATE.terrainCanvas) {
            const size = STATE.terrainCanvasSize;
            const x0 = w * 0.5 - size * 0.5;
            const y0 = h * 0.5 - size * 0.5;
            // Subtle outer glow / frame
            ctx.save();
            ctx.shadowColor = 'rgba(80,160,240,0.40)';
            ctx.shadowBlur = 24;
            ctx.fillStyle = 'rgba(0,0,0,0)';
            ctx.fillRect(x0, y0, size, size);
            ctx.restore();
            ctx.drawImage(STATE.terrainCanvas, x0, y0);
            // Border
            ctx.strokeStyle = 'rgba(255,200,80,0.85)';
            ctx.lineWidth = 2;
            ctx.strokeRect(x0 - 1, y0 - 1, size + 2, size + 2);
            // Inner thin ring
            ctx.strokeStyle = 'rgba(120,180,255,0.30)';
            ctx.lineWidth = 1;
            ctx.strokeRect(x0 + 4, y0 + 4, size - 8, size - 8);
        }

        // 2) Buildings (sensors / generators / turrets / inventory stations)
        const buildings = STATE.hooks.getBuildings ? STATE.hooks.getBuildings() : [];
        for (const b of buildings) {
            if (!b || !b.mesh) continue;
            const p = b.mesh.position;
            const m = _worldToMap(p.x, p.z);
            const type = (b.type || '').toLowerCase();
            let symbol = 'square';
            let color = '#FFC850';
            let teamHex = null;
            // Try to read team color from material (set by enhanceBuildings R32.7)
            if (b.mesh.userData && typeof b.mesh.userData.team === 'number') {
                teamHex = STATE.teamColors[b.mesh.userData.team] || null;
            }
            if (type.includes('flag')) { symbol = 'diamond'; color = teamHex || '#FFC850'; }
            else if (type.includes('turret')) { symbol = 'tri'; color = teamHex || '#E55A30'; }
            else if (type.includes('generator')) { symbol = 'square'; color = teamHex || '#9DDCFF'; }
            else if (type.includes('sensor')) { symbol = 'cross'; color = teamHex || '#A8C8E8'; }
            else if (type.includes('inventory') || type.includes('station')) { symbol = 'square'; color = teamHex || '#C8A050'; }
            else if (type.includes('base') || type.includes('command')) { symbol = 'square'; color = teamHex || '#FFFFFF'; }
            _drawSymbol(ctx, m.x, m.y, symbol, color, 6);
        }

        // 3) Both flags
        const flagInfo = STATE.hooks.getFlagView ? STATE.hooks.getFlagView() : null;
        if (flagInfo && flagInfo.view && flagInfo.stride) {
            const fv = flagInfo.view, fs = flagInfo.stride;
            for (let i = 0; i < 2; i++) {
                const o = i * fs;
                const fx = fv[o], fz = fv[o + 2];
                const ft = fv[o + 3] | 0;   // team
                const fst = fv[o + 4] | 0;  // 0 = home, 1 = carried, 2 = dropped
                if (!Number.isFinite(fx) || !Number.isFinite(fz)) continue;
                const m = _worldToMap(fx, fz);
                const col = STATE.teamColors[ft] || '#FFC850';
                // Pulse
                const pulse = 0.7 + 0.3 * Math.sin(STATE.tick * 0.1);
                ctx.save();
                ctx.globalAlpha = pulse;
                _drawFlag(ctx, m.x, m.y, col, fst);
                ctx.restore();
            }
        }

        // 4) Soldiers
        const pInfo = STATE.hooks.getPlayerView();
        const localIdx = STATE.hooks.getLocalIdx();
        if (pInfo && pInfo.view && pInfo.stride) {
            const pv = pInfo.view, ps = pInfo.stride;
            const localTeam = (localIdx >= 0 && localIdx < pInfo.count)
                ? (pv[localIdx * ps + 11] | 0) : -1;

            for (let i = 0; i < pInfo.count; i++) {
                const o = i * ps;
                const alive = pv[o + 13] > 0.5;
                if (!alive) continue;
                const visible = pv[o + 18] > 0.5;
                const team = pv[o + 11] | 0;
                // Friendly fog-of-war: only show enemies that are visible to your team.
                // (R32.17 v1: simple — show all friendlies, only "visible" enemies.)
                if (team !== localTeam && !visible) continue;
                const px = pv[o], pz = pv[o + 2];
                if (!Number.isFinite(px) || !Number.isFinite(pz)) continue;
                const m = _worldToMap(px, pz);
                const yaw = pv[o + 4];
                const isLocal = (i === localIdx);
                const col = STATE.teamColors[team] || '#FFC850';
                _drawSoldier(ctx, m.x, m.y, yaw, col, isLocal);
            }
        }

        // 5) Local player aim cone
        if (pInfo && localIdx >= 0) {
            const o = localIdx * pInfo.stride;
            const lx = pInfo.view[o], lz = pInfo.view[o + 2];
            const yaw = pInfo.view[o + 4];
            if (Number.isFinite(lx) && Number.isFinite(lz)) {
                const m = _worldToMap(lx, lz);
                _drawAimCone(ctx, m.x, m.y, yaw);
            }
        }

        // 6) HUD overlay text
        _drawHud(ctx, w, h);
    }

    // -------------------------------------------------------------------------
    // Drawing helpers
    // -------------------------------------------------------------------------
    function _drawSymbol(ctx, x, y, kind, color, size) {
        ctx.save();
        ctx.fillStyle = color;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (kind === 'square') {
            ctx.rect(x - size, y - size, size * 2, size * 2);
        } else if (kind === 'diamond') {
            ctx.moveTo(x, y - size);
            ctx.lineTo(x + size, y);
            ctx.lineTo(x, y + size);
            ctx.lineTo(x - size, y);
            ctx.closePath();
        } else if (kind === 'tri') {
            ctx.moveTo(x, y - size);
            ctx.lineTo(x + size * 0.9, y + size * 0.7);
            ctx.lineTo(x - size * 0.9, y + size * 0.7);
            ctx.closePath();
        } else if (kind === 'cross') {
            ctx.moveTo(x - size, y);
            ctx.lineTo(x + size, y);
            ctx.moveTo(x, y - size);
            ctx.lineTo(x, y + size);
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = color;
            ctx.stroke();
            ctx.restore();
            return;
        }
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    function _drawFlag(ctx, x, y, color, state) {
        ctx.save();
        // Pole
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y - 10);
        ctx.lineTo(x, y + 4);
        ctx.stroke();
        // Triangle flag
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, y - 10);
        ctx.lineTo(x + 12, y - 6);
        ctx.lineTo(x, y - 2);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.9)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // State badge
        if (state === 1) { // carried
            ctx.fillStyle = '#FFFFFF';
            ctx.font = 'bold 9px sans-serif';
            ctx.fillText('!', x - 2, y + 14);
        } else if (state === 2) { // dropped
            ctx.strokeStyle = '#FFAA40';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(x, y, 8, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();
    }

    function _drawSoldier(ctx, x, y, yaw, color, isLocal) {
        ctx.save();
        // Yaw arrow (Three.js convention: -yaw → screen up rotation)
        ctx.translate(x, y);
        ctx.rotate(-yaw);
        // Triangle pointing "up" in local space (which is the soldier's forward)
        const r = isLocal ? 6 : 4;
        ctx.fillStyle = color;
        ctx.strokeStyle = isLocal ? '#FFFFFF' : 'rgba(0,0,0,0.85)';
        ctx.lineWidth = isLocal ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(0, -r);
        ctx.lineTo(r * 0.85, r * 0.7);
        ctx.lineTo(-r * 0.85, r * 0.7);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Local-player white halo
        if (isLocal) {
            ctx.beginPath();
            ctx.arc(0, 0, 11, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255,255,255,0.55)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
        ctx.restore();
    }

    function _drawAimCone(ctx, x, y, yaw) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-yaw);
        // Translucent cone, ~60° wide, 90 px long
        const len = 90;
        const halfAng = Math.PI / 6;
        const grad = ctx.createLinearGradient(0, 0, 0, -len);
        grad.addColorStop(0, 'rgba(255,255,255,0.35)');
        grad.addColorStop(1, 'rgba(255,255,255,0.0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.sin(halfAng) * len, -Math.cos(halfAng) * len);
        ctx.lineTo(-Math.sin(halfAng) * len, -Math.cos(halfAng) * len);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    function _drawHud(ctx, w, h) {
        ctx.save();
        // Title
        ctx.fillStyle = '#FFC850';
        ctx.font = 'bold 18px "Barlow Condensed", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('COMMAND  MAP', 28, 36);
        ctx.font = '11px sans-serif';
        ctx.fillStyle = 'rgba(255,200,128,0.65)';
        ctx.fillText('TACTICAL OVERVIEW \u2014 RAINDANCE', 28, 54);

        // Compass rose (top-left)
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('N', w * 0.5, h * 0.5 - STATE.terrainCanvasSize * 0.5 - 8);
        ctx.fillText('S', w * 0.5, h * 0.5 + STATE.terrainCanvasSize * 0.5 + 16);
        ctx.fillText('W', w * 0.5 - STATE.terrainCanvasSize * 0.5 - 12, h * 0.5 + 4);
        ctx.fillText('E', w * 0.5 + STATE.terrainCanvasSize * 0.5 + 12, h * 0.5 + 4);

        // Bottom hint
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '11px sans-serif';
        ctx.fillText('PRESS  C  OR  ESC  TO CLOSE', w * 0.5, h - 22);

        // Legend (bottom-left)
        const lx = 28, ly = h - 130;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(lx - 8, ly - 14, 200, 116);
        ctx.strokeStyle = 'rgba(255,200,80,0.45)';
        ctx.lineWidth = 1;
        ctx.strokeRect(lx - 8, ly - 14, 200, 116);
        ctx.fillStyle = '#FFC850';
        ctx.textAlign = 'left';
        ctx.font = 'bold 11px "Barlow Condensed", sans-serif';
        ctx.fillText('LEGEND', lx, ly);
        ctx.font = '10px sans-serif';
        ctx.fillStyle = '#DDD';
        const items = [
            ['\u25B2', 'Friendly soldier', '#3FA8FF'],
            ['\u25B2', 'Enemy soldier (visible)', '#FF6A4A'],
            ['\u25C6', 'Flag',  '#FFFFFF'],
            ['\u25A0', 'Generator / Station', '#9DDCFF'],
            ['\u25B2', 'Turret', '#E55A30'],
            ['\u271A', 'Sensor', '#A8C8E8'],
        ];
        for (let i = 0; i < items.length; i++) {
            const [glyph, label, col] = items[i];
            ctx.fillStyle = col;
            ctx.font = 'bold 12px sans-serif';
            ctx.fillText(glyph, lx, ly + 18 + i * 14);
            ctx.fillStyle = '#DDD';
            ctx.font = '10px sans-serif';
            ctx.fillText(label, lx + 16, ly + 18 + i * 14);
        }
        ctx.restore();
    }

    // -------------------------------------------------------------------------
    // Public surface
    // -------------------------------------------------------------------------
    window.CommandMap = {
        init,
        update,
        toggle,
        open,
        close,
        isOpen: () => STATE.active,
    };
})();

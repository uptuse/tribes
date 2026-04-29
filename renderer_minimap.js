// renderer_minimap.js — R32.77
// =============================================================================
// Tribes-style Minimap / Radar HUD element.
//
// Circular radar in the bottom-left corner showing:
//   - Team-colored player dots (friendlies + enemies in range)
//   - Flag positions (triangles)
//   - Local player direction indicator (center)
//   - Building footprints
//   - North indicator
//
// Rotates with player yaw so "up" = player's forward direction.
// Updated every frame from the same WASM state views used by renderer.js.
// =============================================================================

(function() {
    'use strict';

    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------
    const RADAR_RADIUS   = 72;           // CSS pixels radius
    const RADAR_DIAMETER = RADAR_RADIUS * 2;
    const WORLD_RANGE    = 200;          // meters of world shown in radar radius
    const BG_ALPHA       = 0.45;         // background circle opacity
    const RING_COLOR     = 'rgba(180,160,120,0.35)';
    const GRID_COLOR     = 'rgba(180,160,120,0.12)';
    // R32.155: Fixed team color inversion — team 0=red, team 1=blue (matches WASM/renderer.js)
    // Uses TEAM_CONFIG from client/team_config.js when available, falls back to corrected literals.
    const _TC = (typeof window !== 'undefined' && window.TEAM_CONFIG) ? window.TEAM_CONFIG : null;
    const TEAM_COLORS    = _TC ? [_TC.teamHudHex(0), _TC.teamHudHex(1)] : ['#FF6A4A', '#3FA8FF']; // team 0=red, team 1=blue
    const ENEMY_GLOW     = 'rgba(255,80,60,0.6)';
    const FRIENDLY_GLOW  = 'rgba(60,160,255,0.5)';
    const FLAG_COLORS    = ['#4488FF', '#FF5533'];  // team 0=blue flag, team 1=red flag
    const BUILDING_COLOR = 'rgba(140,130,100,0.35)';
    const NORTH_COLOR    = '#D4A030';

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------
    const S = {
        canvas: null,
        ctx: null,
        dpr: 1,
        hooks: null,
        enabled: true,
    };

    // -------------------------------------------------------------------------
    // Bootstrap — create the minimap canvas inside the HUD
    // -------------------------------------------------------------------------
    function _bootstrap() {
        if (S.canvas) return;
        const c = document.createElement('canvas');
        c.id = 'minimap-canvas';
        c.style.cssText = [
            'position:absolute',
            'bottom:110px',       // above HUD health/energy bars
            'left:18px',
            'width:' + RADAR_DIAMETER + 'px',
            'height:' + RADAR_DIAMETER + 'px',
            'pointer-events:none',
            'z-index:12',
            'border-radius:50%',
            'opacity:0.9',
        ].join(';') + ';';

        // Attach to the HUD element if it exists, else body
        const hud = document.getElementById('hud');
        if (hud) {
            hud.appendChild(c);
        } else {
            document.body.appendChild(c);
        }

        S.dpr = Math.min(window.devicePixelRatio || 1, 2);
        c.width  = Math.floor(RADAR_DIAMETER * S.dpr);
        c.height = Math.floor(RADAR_DIAMETER * S.dpr);
        S.canvas = c;
        S.ctx = c.getContext('2d');

        window.addEventListener('resize', _onResize);
    }

    function _onResize() {
        if (!S.canvas) return;
        S.dpr = Math.min(window.devicePixelRatio || 1, 2);
        S.canvas.width  = Math.floor(RADAR_DIAMETER * S.dpr);
        S.canvas.height = Math.floor(RADAR_DIAMETER * S.dpr);
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------
    function init(hooks) {
        // hooks = { getPlayerView, getLocalIdx, getFlagView, getBuildings }
        S.hooks = hooks;
        _bootstrap();
        if (window.DEBUG_LOGS) console.log('[R32.77] Minimap initialized');
    }

    function update() {
        if (!S.enabled || !S.hooks || !S.canvas) return;
        // Only draw when HUD is active (game is running)
        const hud = document.getElementById('hud');
        if (!hud || !hud.classList.contains('active')) return;

        const ctx = S.ctx;
        const dpr = S.dpr;
        const cx = RADAR_RADIUS * dpr;  // center x in canvas pixels
        const cy = RADAR_RADIUS * dpr;  // center y in canvas pixels
        const r  = RADAR_RADIUS * dpr;  // radius in canvas pixels

        // Clear
        ctx.clearRect(0, 0, S.canvas.width, S.canvas.height);

        // Get local player data
        const pv = S.hooks.getPlayerView();
        if (!pv || !pv.view) return;
        const view   = pv.view;
        const stride = pv.stride;
        const count  = pv.count;
        const localIdx = S.hooks.getLocalIdx();
        if (localIdx < 0 || localIdx >= count) return;

        const lo = localIdx * stride;
        const lpx = view[lo + 0]; // local player world X
        const lpy = view[lo + 1]; // local player world Y (height)
        const lpz = view[lo + 2]; // local player world Z
        const yaw = view[lo + 4]; // player yaw (rot Y in euler)
        const myTeam = view[lo + 11];
        const alive = view[lo + 13];
        if (alive < 0.5) return; // don't show when dead

        // Rotation: "up" on radar = player forward direction
        // yaw=0 → facing -Z in Three.js, yaw>0 → turning right
        const cosY = Math.cos(-yaw);
        const sinY = Math.sin(-yaw);

        // World-to-radar transform: offset from local player, rotate, scale
        function w2r(wx, wz) {
            const dx = wx - lpx;
            const dz = wz - lpz;
            // Rotate by -yaw so player's forward is up
            const rx = dx * cosY - dz * sinY;
            const ry = dx * sinY + dz * cosY;
            // Scale: WORLD_RANGE meters = r pixels
            const scale = r / WORLD_RANGE;
            return { x: cx + rx * scale, y: cy - ry * scale };
        }

        // --- Background circle ---
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.clip(); // clip everything to circle

        // Dark background
        ctx.fillStyle = 'rgba(8,12,18,' + BG_ALPHA + ')';
        ctx.fillRect(0, 0, S.canvas.width, S.canvas.height);

        // Grid rings at 1/3 and 2/3 radius
        ctx.strokeStyle = GRID_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.333, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.667, 0, Math.PI * 2);
        ctx.stroke();

        // Cross lines
        ctx.beginPath();
        ctx.moveTo(cx - r, cy);
        ctx.lineTo(cx + r, cy);
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx, cy + r);
        ctx.stroke();

        // --- Building footprints ---
        const buildings = S.hooks.getBuildings ? S.hooks.getBuildings() : [];
        if (buildings && buildings.length) {
            ctx.fillStyle = BUILDING_COLOR;
            for (let i = 0; i < buildings.length; i++) {
                const b = buildings[i];
                if (!b || !b.mesh) continue;
                const bp = b.mesh.position;
                // Use approximate footprint from bounding box
                const bb = b.mesh.userData && b.mesh.userData.halfExtents;
                const hx = bb ? bb[0] : 5;
                const hz = bb ? bb[2] : 5;

                // Transform four corners
                const corners = [
                    w2r(bp.x - hx, bp.z - hz),
                    w2r(bp.x + hx, bp.z - hz),
                    w2r(bp.x + hx, bp.z + hz),
                    w2r(bp.x - hx, bp.z + hz),
                ];

                ctx.beginPath();
                ctx.moveTo(corners[0].x, corners[0].y);
                for (let j = 1; j < 4; j++) ctx.lineTo(corners[j].x, corners[j].y);
                ctx.closePath();
                ctx.fill();
            }
        }

        // --- Flags ---
        const fv = S.hooks.getFlagView();
        if (fv && fv.view) {
            const fs = fv.stride;
            for (let i = 0; i < 2; i++) {
                const fo = i * fs;
                const fx = fv.view[fo + 0];
                const fz = fv.view[fo + 2];
                const ft = fv.view[fo + 3]; // team
                const fstate = fv.view[fo + 4]; // 0=base, 1=carried, 2=dropped
                const fp = w2r(fx, fz);

                // Skip if way outside radar
                const dx = fp.x - cx, dy = fp.y - cy;
                if (dx * dx + dy * dy > r * r * 1.5) continue;

                const flagTeamIdx = Math.round(ft);
                const fc = FLAG_COLORS[flagTeamIdx] || '#FFFFFF';

                // Draw flag as triangle
                ctx.save();
                ctx.translate(fp.x, fp.y);
                const flagSize = 6 * dpr;
                ctx.beginPath();
                ctx.moveTo(0, -flagSize);
                ctx.lineTo(-flagSize * 0.6, flagSize * 0.5);
                ctx.lineTo(flagSize * 0.6, flagSize * 0.5);
                ctx.closePath();

                // Glow
                ctx.shadowColor = fc;
                ctx.shadowBlur = 6 * dpr;
                ctx.fillStyle = fc;
                ctx.fill();

                // Pulse if dropped
                if (fstate > 1.5) {
                    ctx.globalAlpha = 0.4 + 0.4 * Math.sin(Date.now() * 0.006);
                    ctx.strokeStyle = '#FFFFFF';
                    ctx.lineWidth = 1.5 * dpr;
                    ctx.stroke();
                    ctx.globalAlpha = 1;
                }

                ctx.shadowBlur = 0;
                ctx.restore();
            }
        }

        // --- Players ---
        for (let i = 0; i < count; i++) {
            const o = i * stride;
            const pAlive   = view[o + 13];
            const pVisible = view[o + 18];
            if (pAlive < 0.5) continue;
            if (i !== localIdx && pVisible < 0.5) continue; // only show visible players

            const px = view[o + 0];
            const pz = view[o + 2];
            const pTeam = Math.round(view[o + 11]);
            const carrying = view[o + 17];
            const pp = w2r(px, pz);

            // Skip if outside radar circle
            const dpx = pp.x - cx, dpy = pp.y - cy;
            if (dpx * dpx + dpy * dpy > r * r) continue;

            if (i === localIdx) {
                // Draw local player as a directional chevron (pointing up = forward)
                ctx.save();
                ctx.translate(pp.x, pp.y);
                const cs = 5 * dpr;
                ctx.beginPath();
                ctx.moveTo(0, -cs * 1.3);
                ctx.lineTo(-cs, cs);
                ctx.lineTo(0, cs * 0.4);
                ctx.lineTo(cs, cs);
                ctx.closePath();
                ctx.fillStyle = '#FFFFFF';
                ctx.shadowColor = '#FFFFFF';
                ctx.shadowBlur = 4 * dpr;
                ctx.fill();
                ctx.shadowBlur = 0;
                ctx.restore();
            } else {
                // Other players — dots
                const isEnemy = (pTeam !== myTeam);
                const dotR = (carrying >= 0) ? 4 * dpr : 2.5 * dpr; // bigger if carrying flag
                const color = TEAM_COLORS[pTeam] || '#888';

                ctx.beginPath();
                ctx.arc(pp.x, pp.y, dotR, 0, Math.PI * 2);
                ctx.fillStyle = color;
                ctx.shadowColor = isEnemy ? ENEMY_GLOW : FRIENDLY_GLOW;
                ctx.shadowBlur = isEnemy ? 6 * dpr : 3 * dpr;
                ctx.fill();
                ctx.shadowBlur = 0;

                // Flag carrier ring
                if (carrying >= 0) {
                    ctx.beginPath();
                    ctx.arc(pp.x, pp.y, dotR + 2 * dpr, 0, Math.PI * 2);
                    ctx.strokeStyle = '#FFFFFF';
                    ctx.lineWidth = 1.5 * dpr;
                    ctx.stroke();
                }
            }
        }

        // --- North indicator ---
        // North = -Z in Three.js world = "up" when yaw=0
        // After rotation, north arrow position is at angle -yaw from top
        const northAngle = -yaw - Math.PI / 2; // angle from right (canvas convention)
        const nx = cx + Math.cos(northAngle) * (r - 8 * dpr);
        const ny = cy + Math.sin(northAngle) * (r - 8 * dpr);
        ctx.font = (9 * dpr) + 'px "Barlow Condensed", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = NORTH_COLOR;
        ctx.fillText('N', nx, ny);

        // --- Outer ring ---
        ctx.restore(); // remove clip
        ctx.beginPath();
        ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
        ctx.strokeStyle = RING_COLOR;
        ctx.lineWidth = 1.5 * dpr;
        ctx.stroke();

        // Range label
        ctx.font = (8 * dpr) + 'px "Barlow Condensed", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(180,160,120,0.5)';
        ctx.fillText(WORLD_RANGE + 'm', cx, cy + r + 10 * dpr);
    }

    // -------------------------------------------------------------------------
    // Expose as window.Minimap
    // -------------------------------------------------------------------------
    window.Minimap = { init: init, update: update };

    if (window.DEBUG_LOGS) console.log('[R32.77] Minimap module loaded');
})();

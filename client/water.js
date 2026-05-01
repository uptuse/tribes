/**
 * Water — animated water plane for the Raindance chasm under the bridge.
 * Single PlaneGeometry with a custom GLSL shader:
 *   - Gerstner wave displacement on the vertex stage
 *   - Fresnel-based reflection/refraction colour blend
 *   - Animated foam edge using noise
 *   - Depth-darkening for visual depth cues
 */

import * as THREE from 'three';

let _water = null;
let _clock = 0;

// Bridge world position from canonical.json:
//   MIS [-291.564, 296.68, 41.0] → world x=-291.564, y=41.0, z=-296.68
// Water sits ~32m below the bridge surface.
const WATER_X   = -291.6;
const WATER_Y   =   8.5;   // just above terrain minimum (~6.65m)
const WATER_Z   = -296.7;
const WATER_W   =  400;    // metres wide
const WATER_D   =  500;    // metres deep (along Z)

const VERT = /* glsl */ `
  uniform float uTime;
  varying vec2  vUv;
  varying float vDepth;   // 0=crest, 1=trough (visual depth cue)
  varying vec3  vNormal;
  varying vec3  vWorldPos;

  // Gerstner wave — physically-based water ripple
  vec3 gerstner(vec3 pos, vec2 dir, float amp, float freq, float speed, float steep) {
    float phase = dot(dir, pos.xz) * freq + uTime * speed;
    float c = cos(phase), s = sin(phase);
    return vec3(
      steep * amp * dir.x * c,
      amp * s,
      steep * amp * dir.y * c
    );
  }

  void main() {
    vUv = uv;
    vec3 p = position;

    // Layer three waves at different scales / directions
    vec3 w1 = gerstner(p, normalize(vec2(1.0, 0.6)),  0.28, 0.25, 0.9, 0.7);
    vec3 w2 = gerstner(p, normalize(vec2(-0.7, 1.0)), 0.18, 0.40, 1.3, 0.6);
    vec3 w3 = gerstner(p, normalize(vec2(0.3, -0.8)), 0.10, 0.70, 1.8, 0.5);

    p += w1 + w2 + w3;
    vDepth     = clamp((p.y + 0.3) * 1.5, 0.0, 1.0);
    vWorldPos  = (modelMatrix * vec4(p, 1.0)).xyz;

    // Approximate normal from wave gradient
    vec3 bitangent = normalize(vec3(1.0, w1.x * 0.25 + w2.x * 0.15, 0.0));
    vec3 tangent   = normalize(vec3(0.0, w1.z * 0.25 + w2.z * 0.15, 1.0));
    vNormal        = normalize(normalMatrix * cross(tangent, bitangent));

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3  uCamPos;
  uniform vec3  uSunDir;

  varying vec2  vUv;
  varying float vDepth;
  varying vec3  vNormal;
  varying vec3  vWorldPos;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y);
  }

  void main() {
    vec3  V       = normalize(uCamPos - vWorldPos);
    vec3  N       = normalize(vNormal);
    vec3  L       = normalize(uSunDir);
    vec3  H       = normalize(L + V);

    // Fresnel
    float cosTheta = max(dot(N, V), 0.0);
    float fresnel  = 0.04 + 0.96 * pow(1.0 - cosTheta, 5.0);

    // Deep vs shallow colour
    vec3  shallowCol = vec3(0.09, 0.38, 0.52);
    vec3  deepCol    = vec3(0.01, 0.09, 0.22);
    vec3  waterCol   = mix(deepCol, shallowCol, vDepth * 0.7);

    // Sky reflection tint (simple)
    vec3  skyCol   = vec3(0.35, 0.58, 0.75);
    vec3  refCol   = mix(waterCol, skyCol, fresnel * 0.6);

    // Specular highlight
    float spec     = pow(max(dot(N, H), 0.0), 180.0) * 2.5;

    // Animated foam / white-caps at wave crests
    float foamNoise = noise(vUv * 12.0 + uTime * 0.4) * noise(vUv * 6.0 - uTime * 0.25);
    float foam      = smoothstep(0.55, 0.75, vDepth) * smoothstep(0.3, 0.7, foamNoise);

    vec3  col = refCol + vec3(spec) + foam * 0.65;

    // Edge darkening toward chasm walls (vUv edges)
    float edge = min(min(vUv.x, 1.0-vUv.x), min(vUv.y, 1.0-vUv.y));
    col *= smoothstep(0.0, 0.08, edge) * 0.4 + 0.6;

    gl_FragColor = vec4(col, 0.88);
  }
`;

export function initWater(scene, camera) {
    const geo = new THREE.PlaneGeometry(WATER_W, WATER_D, 128, 128);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.ShaderMaterial({
        vertexShader:   VERT,
        fragmentShader: FRAG,
        uniforms: {
            uTime:   { value: 0 },
            uCamPos: { value: new THREE.Vector3() },
            uSunDir: { value: new THREE.Vector3(0.6, 0.8, 0.4).normalize() },
        },
        transparent: true,
        side: THREE.FrontSide,
        depthWrite: false,
    });

    _water = new THREE.Mesh(geo, mat);
    _water.position.set(WATER_X, WATER_Y, WATER_Z);
    _water.frustumCulled = false;
    _water.renderOrder   = 1; // after opaque geometry
    scene.add(_water);
    console.log('[Water] Chasm water placed at', WATER_X, WATER_Y, WATER_Z);
}

export function tickWater(dt, camera) {
    if (!_water) return;
    _clock += dt;
    _water.material.uniforms.uTime.value   = _clock;
    _water.material.uniforms.uCamPos.value.copy(camera.position);

    // Sync sun direction from DayNight if available
    const sunDir = window.DayNight?.sunDir;
    if (sunDir) _water.material.uniforms.uSunDir.value.copy(sunDir).normalize();
}

// Njangi On-Chain · Reel 008, "Move. Transact. Save." (after Tayo Oviosu, Paga, at Sui Live 2026).
// Built on the Circles of the World engine: copied from film-ep02.js. ENGINE + SERIES sections are
// unchanged except the opening fade (0.6 s instead of 1.4 s, because this film opens on a hook).
//
// A real-time 3D film rendered frame by frame, deterministic in time:
//   * physically based gold / obsidian / ivory under a studio light rig
//     (softboxes baked into a PMREM environment), key + rim + spot lights
//   * glossy studio floor with blurred reflections (Reflector + mip bias),
//     becoming dark water when the circle "stretches across oceans"
//   * motion blur, depth of field, soft shadows and anti-aliasing all from
//     ONE mechanism: sub-frame accumulation (N renders per frame, each with
//     jittered time, lens aperture, light position and sub-pixel offset)
//   * post: bloom, ACES filmic, vignette, grain, chromatic aberration
//   * Apple-style type: masked per-word rises, blur-to-sharp numerals,
//     metallic gold with a light sheen, all rendered inside the same
//     accumulation so type gets motion blur too
//
// Rules from the series brief: three colours (ink, gold, ivory), one idea
// per shot, the key object centred, eased and overlapping motion, hard cut
// only at 1653 -> "Africa rewrote it.", VO-led.
//
// Contract with marketing/tools/render-webgl.js: window.__ready, and
// window.__frame(t, samples) -> data: URL of raw RGBA (bottom-up).

import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { TexturePass } from 'three/addons/postprocessing/TexturePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const W = 1080, H = 1920, FPS = 30;

// ============================================================ ENGINE (shared by every episode; change with care)
// ------------------------------------------------------------ helpers
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, p) => a + (b - a) * p;
const E = {
  lin: (x) => x,
  inOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  inOutQuint: (x) => (x < 0.5 ? 16 * x ** 5 : 1 - Math.pow(-2 * x + 2, 5) / 2),
  outCubic: (x) => 1 - Math.pow(1 - x, 3),
  outQuint: (x) => 1 - Math.pow(1 - x, 5),
  outExpo: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  inCubic: (x) => x * x * x,
  inQuad: (x) => x * x,
  outBack: (x) => { const c1 = 1.25, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); },
};
const P = (t, a, b, e = E.inOutCubic) => (b <= a ? (t >= b ? 1 : 0) : e(clamp((t - a) / (b - a))));
const pulseWin = (t, a, rise, hold, fall) => P(t, a, a + rise, E.outCubic) * (1 - P(t, a + rise + hold, a + rise + hold + fall, E.inOutSine));
const lin = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const D2R = Math.PI / 180;
function halton(i, b) { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }

// ============================================================ EPISODE: timeline marks (word-timed beats)
// ------------------------------------------------------------ timeline
const params = new URLSearchParams(location.search);
const TL = await (await fetch(params.get('tl'))).json();
// fonts first: every text block is measured and rasterised at construction
await Promise.all([
  document.fonts.load('600 112px "Inter Tight"'), document.fonts.load('500 44px "Inter Tight"'),
  document.fonts.load('400 120px "Instrument Serif"'), document.fonts.load('italic 400 120px "Instrument Serif"'),
  document.fonts.load('500 24px "IBM Plex Mono"'),
]);
await document.fonts.ready;
const SC = TL.scenes;
const VIS = Object.fromEntries(SC.map((s) => [s.visual, s]));
const T_END = TL.total;
const norm = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, '');
function wt(visual, word, n = 0, frac = 0.5) {
  const s = VIS[visual]; if (!s) return 1e9;
  const k = norm(word); let c = 0;
  for (const w of s.words) { if (norm(w.w) === k) { if (c === n) return w.t; c++; } }
  return lerp(s.v0, s.v1, frac);
}
const M = {
  // 1 · the hook: a phone lying dark ("has no app")
  h0: VIS.phone.t0, has: wt('phone', 'has'),
  // 2 · move, transact, save: two routes over dark water gather into the circle on "save"
  tr0: VIS.triad.t0, move: wt('triad', 'move'), transact: wt('triad', 'transact'), save: wt('triad', 'save'),
  // 3 · the saving part, built long ago: esusu, njangi, susu
  he0: VIS.heritage.t0, esusu: wt('heritage', 'esusu'), njangi: wt('heritage', 'njangi'), susu: wt('heritage', 'susu'),
  // 4 · everyone pays in, one takes the pot, it goes round (Ep. 1's three beats in one scene)
  p0: VIS.mechanic.t0, flow: wt('mechanic', 'everyone') - 0.12, takes: wt('mechanic', 'takes'), pot: wt('mechanic', 'pot'), round: wt('mechanic', 'round'),
  // 5 · the catch, 6 · nobody holds the pot
  c0: VIS.catch.t0, someone: wt('catch', 'somebody'), hold: wt('catch', 'hold'),
  n0: VIS.nobody.t0, kept: wt('nobody', 'kept'), nob: wt('nobody', 'nobody'), even: wt('nobody', 'even'),
  // 7 · the brand card
  ti0: VIS.title.t0, brand: wt('title', 'njangi'), same: wt('title', 'same'), friction: wt('title', 'friction'),
};
M.mvA = M.move - 0.3; M.mvB = M.mvA + 1.25;              // "move": a route races out to the horizon
M.trA = M.transact - 0.3; M.trB = M.trA + 1.25;          // "transact": a second one comes back across it
M.formA = Math.max(M.save - 0.25, M.trB - 0.2);          // "save": both gather into the circle
M.formB = M.formA + 1.9;
M.memA = M.formB - 0.55;
M.k0 = M.takes - 0.3; M.o0 = M.round - 0.3;              // headline swaps inside the one mechanic scene
M.liftA = M.takes - 0.15; M.moveA = Math.max(M.pot - 0.3, M.liftA + 0.4); M.moveB = M.moveA + 0.95;
M.roundA = M.round - 0.12; M.roundB = M.roundA + 2.3;   // done before the dissolve into the catch

// ============================================================ ENGINE: renderer, light rig, materials, floor
// ------------------------------------------------------------ renderer
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;   // softness comes from the jittered light
renderer.autoClear = false;
const gl = renderer.getContext();
const floatBlend = !!gl.getExtension('EXT_float_blend');

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x040507, 0);
const camera = new THREE.PerspectiveCamera(32, W / H, 0.05, 200);
camera.layers.enable(0);

// ------------------------------------------------------------ studio environment
function studioEnvironment(variant = 'studio') {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.BoxGeometry(40, 40, 40), new THREE.MeshBasicMaterial({ color: lin(0.003, 0.003, 0.0035), side: THREE.BackSide })));
  const panel = (w, h, pos, look, rgb) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: lin(...rgb), side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(...look); s.add(m);
  };
  // a warm horizon band all the way round: gold never falls to black at any angle
  const band = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, 7, 64, 1, true), new THREE.MeshBasicMaterial({ color: lin(0.16, 0.12, 0.085), side: THREE.BackSide }));
  band.position.y = 3.2; s.add(band);
  panel(18, 10, [0, 10, 0], [0, 0, 0], [1.05, 0.96, 0.84]);        // big overhead softbox
  panel(3, 14, [-9, 3, 2], [0, 2, 2], [1.35, 1.1, 0.8]);            // left strip, warm
  panel(3, 14, [9, 3, -1], [0, 2, -1], [0.7, 0.8, 1.0]);             // right strip, cool
  panel(18, 2.4, [0, 2.2, -12], [0, 2, 0], [0.55, 0.48, 0.4]);       // back kicker
  panel(7, 3.5, [2.5, 3.5, 10], [0, 0.5, 0], [0.62, 0.56, 0.5]);     // front fill
  if (variant === 'coins') {
    // a large warm source behind the lens so the standing faces read as gold
    panel(11, 7, [0.8, 2.6, 13], [0, 0.4, 0], [1.1, 0.86, 0.6]);
  }
  const pm = new THREE.PMREMGenerator(renderer);
  return pm.fromScene(s, 0.0, 0.1, 100).texture;
}
const ENV = studioEnvironment();
const ENV_COINS = studioEnvironment('coins');
const pbr = [];   // every PBR material, so environment intensity can be driven per shot
function env(mat, base = 1) { mat.envMap = ENV; mat.userData.envBase = base; mat.userData.envMul = 1; pbr.push(mat); return mat; }
let envGlobal = 1;
function applyEnv() { for (const m of pbr) m.envMapIntensity = m.userData.envBase * m.userData.envMul * envGlobal; }

// ------------------------------------------------------------ materials
const GOLD = lin(1.0, 0.70, 0.30);
const GOLD_OLD = lin(0.86, 0.58, 0.24);
const OBSIDIAN = lin(0.006, 0.006, 0.008);
const goldMat = (rough = 0.15) => env(new THREE.MeshPhysicalMaterial({ color: GOLD.clone(), metalness: 1, roughness: rough, clearcoat: 0.25, clearcoatRoughness: 0.06 }), 1.15);
const obsidianMat = () => env(new THREE.MeshPhysicalMaterial({ color: OBSIDIAN.clone(), metalness: 0, roughness: 0.13, clearcoat: 1, clearcoatRoughness: 0.03, ior: 1.6 }), 1.3);

// ------------------------------------------------------------ background (screen-space, main camera only)
const bgMat = new THREE.ShaderMaterial({
  uniforms: { uBase: { value: lin(0.0015, 0.0015, 0.002) }, uGlow: { value: lin(0.02, 0.015, 0.01) }, uCenter: { value: new THREE.Vector2(0.5, 0.56) }, uRadius: { value: 0.6 }, uHide: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.99999, 1.0); }',
  fragmentShader: `uniform vec3 uBase; uniform vec3 uGlow; uniform vec2 uCenter; uniform float uRadius; uniform float uHide; varying vec2 vUv;
    void main(){ if (uHide > 0.5) discard; vec2 p = (vUv - uCenter) * vec2(0.5625, 1.0); float d = length(p) / uRadius;
      gl_FragColor = vec4(uBase + uGlow * exp(-d * d * 1.7), 1.0); }`,
  depthWrite: false, depthTest: false,
});
const bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat);
bg.frustumCulled = false; bg.renderOrder = -1000;
bg.onBeforeRender = (r, s, cam) => { bgMat.uniforms.uHide.value = cam === camera ? 0 : 1; bgMat.uniformsNeedUpdate = true; };
scene.add(bg);

// ------------------------------------------------------------ floor: blurred reflections, can turn to water
const FloorShader = {
  name: 'StudioFloor',
  uniforms: {
    color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
    uBase: { value: lin(0.004, 0.004, 0.0048) }, uReflect: { value: 0.6 }, uBlur: { value: 2.2 },
    uWater: { value: 0 }, uTime: { value: 0 }, uCam: { value: new THREE.Vector3() },
    uSpot: { value: new THREE.Vector4(0, 0, 0, 1.6) }, uSpotColor: { value: lin(0.0, 0.0, 0.0) },
    uFogColor: { value: lin(0.002, 0.0025, 0.004) }, uFog: { value: 0 },
  },
  vertexShader: `uniform mat4 textureMatrix; varying vec4 vUv; varying vec3 vWorld;
    void main(){ vUv = textureMatrix * vec4(position, 1.0); vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec3 uBase; uniform float uReflect; uniform float uBlur; uniform float uWater; uniform float uTime;
    uniform vec3 uCam; uniform vec4 uSpot; uniform vec3 uSpotColor; uniform vec3 uFogColor; uniform float uFog;
    varying vec4 vUv; varying vec3 vWorld;
    float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float n2(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
      return mix(mix(h(i), h(i+vec2(1,0)), u.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), u.x), u.y); }
    vec2 grad(vec2 p){ float e = 0.04; float c = n2(p); return vec2(n2(p+vec2(e,0.0))-c, n2(p+vec2(0.0,e))-c) / e; }
    void main(){
      vec3 V = normalize(uCam - vWorld);
      float fres = 0.04 + 0.96 * pow(1.0 - clamp(V.y, 0.0, 1.0), 5.0);
      vec4 uv = vUv;
      float wave = 0.0;
      if (uWater > 0.001) {
        vec2 p = vWorld.xz;
        vec2 g = grad(p * 1.7 + vec2(uTime * 0.10, uTime * 0.06)) * 0.65 + grad(p * 4.3 - vec2(uTime * 0.16, -uTime * 0.09)) * 0.3;
        uv.xy += g * 0.03 * uWater * uv.w;
        wave = (g.x + g.y) * 0.5;
      }
      vec3 refl = texture2DProj(tDiffuse, uv, uBlur + uWater * 1.2).rgb;
      float dcam = length(uCam.xz - vWorld.xz);
      float fade = 1.0 - smoothstep(6.0, 22.0, dcam);
      vec3 col = uBase * (1.0 + uWater * (0.8 + wave * 0.6));
      col += uWater * vec3(0.010, 0.016, 0.03) * fres * (0.6 + 0.8 * clamp(wave * 2.0 + 0.5, 0.0, 1.0));
      col += refl * uReflect * mix(0.28, 1.0, fres) * fade;
      col += uSpotColor * exp(-pow(length(vWorld.xz - uSpot.xy) / uSpot.w, 2.0));
      float fd = length(uCam - vWorld);
      col = mix(col, uFogColor, 1.0 - exp(-uFog * uFog * fd * fd));
      gl_FragColor = vec4(col, 1.0);
    }`,
};
const floor = new Reflector(new THREE.PlaneGeometry(80, 80), { textureWidth: W / 2, textureHeight: H / 2, clipBias: 0.002, multisample: 0, shader: FloorShader });
floor.rotation.x = -Math.PI / 2;
{ const t = floor.getRenderTarget().texture; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; }
scene.add(floor);
const FU = floor.material.uniforms;
const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ opacity: 0.62 }));
shadowCatcher.rotation.x = -Math.PI / 2; shadowCatcher.position.y = 0.0012; shadowCatcher.receiveShadow = true;
scene.add(shadowCatcher);

// ------------------------------------------------------------ lights
const key = new THREE.DirectionalLight(0xffffff, 2.0);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -4.5, right: 4.5, top: 4.5, bottom: -4.5, near: 0.5, far: 30 });
key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
scene.add(key, key.target);
const rim = new THREE.DirectionalLight(0xffffff, 0.8);
scene.add(rim, rim.target);
const spot = new THREE.SpotLight(0xffffff, 0, 14, 0.36, 0.85, 1.4);
spot.castShadow = true; spot.shadow.mapSize.set(2048, 2048); spot.shadow.bias = -0.0003; spot.shadow.normalBias = 0.012;
scene.add(spot, spot.target);
const lightBase = { key: V3(2, 6, 3.5), spot: V3(1, 3, 2) };

// ------------------------------------------------------------ groups
const phoneG = new THREE.Group(), circleG = new THREE.Group(), oceanG = new THREE.Group();
scene.add(phoneG, circleG, oceanG);

// ============================================================ EPISODE: scene 1 set (a phone lying dark: "has no app")
// A generic phone, not any maker's: a rounded slab, satin graphite frame, a black glass face.
// No logo and no interface. The screen stays off for the whole shot; that is the point.
function roundedRect(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
const PH_W = 0.74, PH_L = 1.5, PH_R = 0.13, PH_T = 0.075, PH_B = 0.024;
const phoneBodyGeo = new THREE.ExtrudeGeometry(roundedRect(PH_W - 2 * PH_B, PH_L - 2 * PH_B, PH_R - PH_B), {
  depth: PH_T - 2 * PH_B, bevelEnabled: true, bevelThickness: PH_B, bevelSize: PH_B, bevelSegments: 10, curveSegments: 64,
});
phoneBodyGeo.rotateX(-Math.PI / 2); phoneBodyGeo.translate(0, PH_B, 0);   // lying flat, sitting on the floor
const phoneFrame = env(new THREE.MeshPhysicalMaterial({ color: lin(0.09, 0.09, 0.1), metalness: 1, roughness: 0.3, clearcoat: 0.35, clearcoatRoughness: 0.12 }), 1.0);
const phoneGlass = env(new THREE.MeshPhysicalMaterial({ color: lin(0.002, 0.002, 0.0026), metalness: 0, roughness: 0.035, clearcoat: 1, clearcoatRoughness: 0.02, ior: 1.52 }), 1.5);
const phoneMats = [phoneFrame, phoneGlass];
const phone = new THREE.Mesh(phoneBodyGeo, phoneFrame);
phone.castShadow = true; phone.receiveShadow = true;
const glassGeo = new THREE.ShapeGeometry(roundedRect(PH_W - 2 * PH_B - 0.006, PH_L - 2 * PH_B - 0.006, PH_R - PH_B - 0.003), 48);
glassGeo.rotateX(-Math.PI / 2);
const glass = new THREE.Mesh(glassGeo, phoneGlass);
glass.position.y = PH_T + 0.0006; glass.receiveShadow = true;
phoneG.add(phone, glass);
phoneG.rotation.y = 0.32;
phoneG.position.set(0, 0, 0.05);
// The glass needs something to reflect: a tall softbox behind the phone, raised ~37 degrees, which the
// environment rotation slides across the screen (the classic product-shot sweep), plus a dim overhead
// and a warm side strip so the frame's edge still reads.
function phoneEnvironment() {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.BoxGeometry(40, 40, 40), new THREE.MeshBasicMaterial({ color: lin(0.003, 0.003, 0.0035), side: THREE.BackSide })));
  const band = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, 7, 64, 1, true), new THREE.MeshBasicMaterial({ color: lin(0.12, 0.09, 0.065), side: THREE.BackSide }));
  band.position.y = 3.2; s.add(band);
  const panel = (w, h, pos, rgb) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: lin(...rgb), side: THREE.DoubleSide })); m.position.set(...pos); m.lookAt(0, 0, 0); s.add(m); };
  panel(2.0, 12, [0, 7.5, -10], [1.5, 1.38, 1.2]);    // a strip light: one bright band crosses the glass
  panel(6, 10, [0, 7.5, -10.4], [0.16, 0.145, 0.13]); // its soft spill, so the band has a falloff
  panel(18, 10, [0, 10, 0], [0.5, 0.46, 0.4]);
  panel(3, 14, [-9, 3, 2], [0.6, 0.5, 0.36]);
  const pm = new THREE.PMREMGenerator(renderer);
  return pm.fromScene(s, 0.0, 0.1, 100).texture;
}
const ENV_PHONE = phoneEnvironment();
for (const m of phoneMats) m.envMap = ENV_PHONE;
function phoneEnvRot(a) { for (const m of phoneMats) m.envMapRotation.set(0, a, 0); }

// ============================================================ SERIES: the circle motif (ring, members, pot, threads) — reused every episode
const R = 1.0, NM = 8, MR = 0.072;
const theta = (i) => Math.PI / 2 + (i * 2 * Math.PI) / NM;   // member 0 = front (nearest the camera)

class Tube {
  constructor(seg, radial, material, { castShadow = true } = {}) {
    this.S = seg; this.RR = radial;
    const n = (seg + 1) * (radial + 1);
    this.pos = new Float32Array(n * 3); this.nor = new Float32Array(n * 3);
    const idx = [];
    for (let i = 0; i < seg; i++) for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = (i + 1) * (radial + 1) + j, c = b + 1, d = a + 1;
      idx.push(a, b, d, b, c, d);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(idx);
    this.geo.boundingSphere = new THREE.Sphere(V3(0, 0, 0), 50);
    this.mesh = new THREE.Mesh(this.geo, material); this.mesh.frustumCulled = false; this.mesh.castShadow = castShadow;
    const cap = new THREE.SphereGeometry(1, 20, 14);
    this.capA = new THREE.Mesh(cap, material); this.capB = new THREE.Mesh(cap, material);
    this.capA.castShadow = this.capB.castShadow = castShadow;
    this.group = new THREE.Group(); this.group.add(this.mesh, this.capA, this.capB);
    this.P = Array.from({ length: seg + 1 }, () => new THREE.Vector3());
  }
  // fn(s) -> Vector3 (writes into out); radius(s) -> number
  update(fn, s0, s1, radius, closed = false) {
    const S = this.S, RR = this.RR, P = this.P;
    for (let i = 0; i <= S; i++) fn(s0 + ((s1 - s0) * i) / S, P[i]);
    const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), tmp = new THREE.Vector3();
    let k = 0;
    for (let i = 0; i <= S; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(S, i + 1)];
      if (closed && (i === 0 || i === S)) T.subVectors(P[1], P[S - 1]); else T.subVectors(b, a);
      T.normalize();
      if (i === 0) { N.set(0, 1, 0); if (Math.abs(T.dot(N)) > 0.95) N.set(0, 0, 1); }
      N.addScaledVector(T, -N.dot(T)).normalize();
      B.crossVectors(T, N);
      const r = radius((s0 + ((s1 - s0) * i) / S));
      for (let j = 0; j <= RR; j++) {
        const ph = (j / RR) * Math.PI * 2, c = Math.cos(ph), s = Math.sin(ph);
        tmp.set(0, 0, 0).addScaledVector(N, c).addScaledVector(B, s);
        this.nor[k] = tmp.x; this.nor[k + 1] = tmp.y; this.nor[k + 2] = tmp.z;
        this.pos[k] = P[i].x + tmp.x * r; this.pos[k + 1] = P[i].y + tmp.y * r; this.pos[k + 2] = P[i].z + tmp.z * r;
        k += 3;
      }
    }
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.normal.needsUpdate = true;
    const r0 = radius(s0), r1 = radius(s1);
    this.capA.position.copy(P[0]); this.capA.scale.setScalar(Math.max(1e-4, r0));
    this.capB.position.copy(P[S]); this.capB.scale.setScalar(Math.max(1e-4, r1));
    this.capA.visible = this.capB.visible = !closed && s1 - s0 > 1e-3;
    this.mesh.visible = s1 - s0 > 1e-4;
  }
}
const ringMat = goldMat(0.13);
const ring = new Tube(520, 16, ringMat);
circleG.add(ring.group);
const glowMat = new THREE.MeshBasicMaterial({ color: lin(1.5, 0.98, 0.38), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 1 });
const glowRing = new Tube(360, 10, glowMat, { castShadow: false });
circleG.add(glowRing.group);

const members = [];
for (let i = 0; i < NM; i++) {
  const mat = obsidianMat();
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(MR, 64, 48), mat);
  mesh.castShadow = true;
  circleG.add(mesh);
  members.push({ mesh, mat });
}
const orbMat = goldMat(0.11);
const orb = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), orbMat);
orb.castShadow = true; circleG.add(orb);
const beads = Array.from({ length: NM }, () => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.03, 32, 20), goldMat(0.12)); m.castShadow = true; circleG.add(m); return m; });

// threads (glowing gold filaments): unit cylinder along +z, placed between two points
const threadGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true); threadGeo.translate(0, 0.5, 0); threadGeo.rotateX(Math.PI / 2);
const threadMat = goldMat(0.2);
threadMat.emissive = GOLD.clone().multiplyScalar(0.12);
const mkThread = () => { const m = new THREE.Mesh(threadGeo, threadMat.clone()); env(m.material, 1.15); m.material.transparent = true; m.frustumCulled = false; circleG.add(m); return m; };
const spokes = Array.from({ length: NM }, mkThread);
const chords = Array.from({ length: NM }, mkThread);
function placeThread(m, a, b, draw, radius, opacity) {
  if (draw <= 0.001 || opacity <= 0.001) { m.visible = false; return; }
  m.visible = true; m.position.copy(a); m.lookAt(b);
  m.scale.set(radius, radius, a.distanceTo(b) * draw);
  m.material.opacity = opacity;
}
// floor pulses
const pulseGeo = new THREE.RingGeometry(0.93, 1.0, 128); pulseGeo.rotateX(-Math.PI / 2);
const pulses = Array.from({ length: NM + 2 }, () => { const m = new THREE.Mesh(pulseGeo, new THREE.MeshBasicMaterial({ color: lin(0.7, 0.46, 0.17), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })); m.position.y = 0.003; circleG.add(m); return m; });
function placePulse(m, x, z, t, t0, r0 = 0.08, r1 = 0.24, dur = 0.9, k = 1) {
  const q = (t - t0) / dur;
  if (q < 0 || q > 1) { m.visible = false; return; }
  m.visible = true; m.position.x = x; m.position.z = z;
  m.scale.setScalar(lerp(r0, r1, E.outCubic(q)));
  m.material.opacity = (1 - q) * (1 - q) * k;
}

// the word "tontine" as a plane in 3D (so the wire can strike through it in space)
const worldWordMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: null }, uOpacity: { value: 1 }, uBias: { value: 0 }, uColor: { value: lin(0.92, 0.88, 0.8) } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform sampler2D map; uniform float uOpacity; uniform float uBias; uniform vec3 uColor; varying vec2 vUv; void main(){ float a = texture2D(map, vUv, uBias).a * uOpacity; gl_FragColor = vec4(uColor * a, a); }',
  transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
});
const worldWord = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), worldWordMat);
circleG.add(worldWord);

// ============================================================ EPISODE: scene 2 set (two routes over dark water)
// "Move": a route races out from near us to the horizon. "Transact": a second one comes back
// across it. On "save" both gather into the circle: route 1 becomes its right half, route 2 its left.
// Portrait frames are only ~17 degrees wide, so both recede in depth and stay near the centre line.
const mkRoute = (pts) => { const c = new THREE.CatmullRomCurve3(pts, false, 'centripetal'); c.arcLengthDivisions = 800; return c; };
const ROUTE_MOVE = mkRoute([V3(0.32, 0.03, 0.35), V3(0.14, 0.17, -2.7), V3(-0.42, 0.22, -6.3), V3(-1.05, 0.03, -10.6)]);
const ROUTE_BACK = mkRoute([V3(1.0, 0.03, -10.2), V3(0.48, 0.2, -6.1), V3(-0.08, 0.15, -2.6), V3(-0.36, 0.03, 0.05)]);
const route2 = new Tube(520, 16, ringMat);   // route 1 is drawn by the series ring tube itself
circleG.add(route2.group);
const ROUTE_NODES = [ROUTE_MOVE.points[0], ROUTE_MOVE.points[3], ROUTE_BACK.points[0], ROUTE_BACK.points[3]];
const routeNodes = ROUTE_NODES.map((p) => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.05, 40, 28), goldMat(0.14));
  m.position.copy(p).setY(0.05); oceanG.add(m); return m;
});
const mkPulse = () => new THREE.Mesh(pulseGeo, new THREE.MeshBasicMaterial({ color: lin(0.7, 0.46, 0.17), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
const routePulses = ROUTE_NODES.map((p) => { const m = mkPulse(); m.position.set(p.x, 0.004, p.z); m.visible = false; oceanG.add(m); return m; });
// the leading edge of each route glows as it travels: money on the move
const tipMat = new THREE.MeshBasicMaterial({ color: lin(1.5, 0.98, 0.38), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
const tips = [0, 1].map(() => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.045, 24, 16), tipMat); m.visible = false; oceanG.add(m); return m; });
// one ring of light per tradition name (esusu, njangi, susu): the same circle, three names
const namePulseGeo = new THREE.RingGeometry(0.985, 1.0, 160); namePulseGeo.rotateX(-Math.PI / 2);
const namePulses = Array.from({ length: 3 }, () => { const m = mkPulse(); m.geometry = namePulseGeo; m.position.y = 0.003; m.visible = false; circleG.add(m); return m; });

// ============================================================ ENGINE: overlay type (TextBlock: rise / focus / fade)
const overlay = new THREE.Scene();
const ortho = new THREE.OrthographicCamera(0, W, 0, -H, -10, 10);
const TextShader = {
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D map; uniform vec3 uColor; uniform float uOpacity; uniform float uBias; uniform vec4 uClip; uniform float uGold; uniform float uSheen; varying vec2 vUv;
    void main(){
      if (gl_FragCoord.x < uClip.x || gl_FragCoord.x > uClip.z || gl_FragCoord.y < uClip.y || gl_FragCoord.y > uClip.w) discard;
      float a = texture2D(map, vUv, uBias).a * uOpacity;
      vec3 c = uColor;
      if (uGold > 0.5) {
        float y = vUv.y;
        c = mix(vec3(0.30, 0.15, 0.035), mix(vec3(0.74, 0.45, 0.13), vec3(0.95, 0.76, 0.44), smoothstep(0.42, 0.8, y)), smoothstep(0.16, 0.52, y));
        float band = (gl_FragCoord.x * 0.9 + gl_FragCoord.y * 0.45) / 1500.0 - uSheen;
        c += vec3(0.55, 0.45, 0.3) * exp(-band * band / 0.0016);
      }
      gl_FragColor = vec4(c * a, a);
    }`,
};
const measure = document.createElement('canvas').getContext('2d');
function wordTexture(text, font, spacing) {
  measure.font = font; measure.letterSpacing = `${spacing}px`;
  const m = measure.measureText(text);
  const size = parseFloat(font.match(/(\d+(?:\.\d+)?)px/)[1]);
  const pad = Math.ceil(size * 0.3);
  const w = Math.ceil(m.width) + pad * 2, h = Math.ceil(size * 1.5);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.font = font; g.letterSpacing = `${spacing}px`; g.fillStyle = '#fff'; g.textBaseline = 'alphabetic';
  const base = Math.round(size * 1.1);
  g.fillText(text, pad, base);
  const tex = new THREE.CanvasTexture(c);
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.anisotropy = 4;
  return { tex, w, h, pad, base, adv: m.width };
}
const FULL_CLIP = new THREE.Vector4(-1e5, -1e5, 1e5, 1e5);
class TextBlock {
  // text: '\n' = line break, *word* = gold. y = top of first line (px from top).
  constructor(text, { family = 'Inter Tight', weight = 600, style = 'normal', size = 112, spacing = null, lineHeight = 1.04, y = 300, x = W / 2, maxWidth = 940, color = lin(0.88, 0.85, 0.79), gold = false, order = 10 } = {}) {
    const font = `${style} ${weight} ${size}px "${family}"`;
    const sp = spacing ?? -size * 0.03;
    this.size = size; this.lineH = size * lineHeight; this.words = []; this.lines = [];
    measure.font = font; measure.letterSpacing = `${sp}px`;
    const space = measure.measureText(' ').width;
    const tokens = text.split('\n').map((ln) => ln.split(' ').filter(Boolean));
    let inGold = false;
    const rows = [];
    for (const lnTokens of tokens) {
      const items = lnTokens.map((tk) => {
        let t = tk, g = inGold;
        if (t.startsWith('*')) { g = true; inGold = true; t = t.slice(1); }
        if (t.endsWith('*')) { inGold = false; t = t.slice(0, -1); }
        measure.font = font; measure.letterSpacing = `${sp}px`;
        return { t, gold: g || gold, w: measure.measureText(t).width };
      });
      // balanced wrap into at most 2 lines per paragraph
      const total = items.reduce((a, b) => a + b.w, 0) + space * (items.length - 1);
      if (total <= maxWidth || items.length < 2) { rows.push(items); continue; }
      let best = 1, bestCost = 1e9;
      for (let k = 1; k < items.length; k++) {
        const w1 = items.slice(0, k).reduce((a, b) => a + b.w, 0) + space * (k - 1);
        const w2 = items.slice(k).reduce((a, b) => a + b.w, 0) + space * (items.length - k - 1);
        const cost = Math.max(w1, w2) + (w1 > maxWidth || w2 > maxWidth ? 1e6 : 0);
        if (cost < bestCost) { bestCost = cost; best = k; }
      }
      rows.push(items.slice(0, best), items.slice(best));
    }
    rows.forEach((items, li) => {
      const lw = items.reduce((a, b) => a + b.w, 0) + space * (items.length - 1);
      let cx = x - lw / 2;
      const baseline = y + li * this.lineH + size * 0.86;
      this.lines.push({ top: baseline - size * 0.98, bottom: baseline + size * 0.3 });
      for (const it of items) {
        const tx = wordTexture(it.t, font, sp);
        const mat = new THREE.ShaderMaterial({
          uniforms: { map: { value: tx.tex }, uColor: { value: color.clone() }, uOpacity: { value: 0 }, uBias: { value: 0 }, uClip: { value: FULL_CLIP.clone() }, uGold: { value: it.gold ? 1 : 0 }, uSheen: { value: -2 } },
          vertexShader: TextShader.vertexShader, fragmentShader: TextShader.fragmentShader,
          transparent: true, depthTest: false, depthWrite: false,
          blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(tx.w, tx.h), mat);
        mesh.renderOrder = order; mesh.visible = false;
        const bx = cx - tx.pad + tx.w / 2, by = baseline - tx.base + tx.h / 2;
        mesh.position.set(bx, -by, 0);
        overlay.add(mesh);
        this.words.push({ mesh, mat, line: li, bx, by, text: it.t, adv: it.w });
        cx += it.w + space;
      }
    });
    this.cx = x; this.cy = y + (rows.length * this.lineH) / 2;
  }
  hide() { for (const w of this.words) w.mesh.visible = false; }
  // Apple rise: each word slides up out of a mask on its line, staggered.
  rise(t, tin, tout, { stagger = 0.055, dur = 1.0, outDur = 0.55, lift = 1.0, sheen = true } = {}) {
    const q = tout == null ? 0 : P(t, tout, tout + outDur, E.inOutCubic);
    this.words.forEach((w, j) => {
      const a = tin + j * stagger;
      const p = P(t, a, a + dur, E.outExpo);
      const o = P(t, a, a + dur * 0.45, E.lin) * (1 - q);
      w.mesh.visible = o > 0.001;
      if (!w.mesh.visible) return;
      const L = this.lines[w.line];
      const dy = (1 - p) * this.lineH * lift - q * 18;
      w.mesh.position.set(w.bx, -(w.by + dy), 0);
      w.mesh.scale.setScalar(1);
      w.mat.uniforms.uOpacity.value = o;
      w.mat.uniforms.uBias.value = q * 2.5;
      w.mat.uniforms.uClip.value.set(-1e5, H - L.bottom - this.size * 0.12, 1e5, H - L.top + this.size * 0.08 + (q > 0 ? 400 : 0));
      w.mat.uniforms.uSheen.value = sheen ? lerp(-0.4, 1.9, P(t, tin + 0.35, tin + 2.3, E.inOutSine)) : -2;
    });
  }
  // Big numerals / names: defocus -> focus, gentle settle in scale.
  focus(t, tin, tout, { dur = 1.8, outDur = 0.6, scale0 = 1.07 } = {}) {
    const q = tout == null ? 0 : P(t, tout, tout + outDur, E.inOutCubic);
    const p = P(t, tin, tin + dur, E.outCubic);
    const o = P(t, tin, tin + dur * 0.6, E.inOutSine) * (1 - q);
    const s = lerp(scale0, 1, P(t, tin, tin + dur * 1.6, E.outCubic));
    for (const w of this.words) {
      w.mesh.visible = o > 0.001;
      if (!w.mesh.visible) continue;
      w.mesh.position.set(this.cx + (w.bx - this.cx) * s, -(this.cy + (w.by - this.cy) * s), 0);
      w.mesh.scale.setScalar(s);
      w.mat.uniforms.uOpacity.value = o;
      w.mat.uniforms.uBias.value = (1 - p) * 5.5 + q * 3;
      w.mat.uniforms.uClip.value.copy(FULL_CLIP);
      w.mat.uniforms.uSheen.value = lerp(-0.4, 1.9, P(t, tin + 0.5, tin + 2.6, E.inOutSine));
    }
  }
  fade(t, tin, tout, { dur = 0.5, rise = 10, dx: ox = 0, dy: oy = 0 } = {}) {
    const o = P(t, tin, tin + dur, E.inOutSine) * (tout == null ? 1 : 1 - P(t, tout, tout + dur, E.inOutSine));
    const dy = (1 - P(t, tin, tin + dur * 1.4, E.outCubic)) * rise;
    for (const w of this.words) {
      w.mesh.visible = o > 0.001;
      if (!w.mesh.visible) continue;
      w.mesh.position.set(w.bx + ox, -(w.by + dy + oy), 0); w.mesh.scale.setScalar(1);
      w.mat.uniforms.uOpacity.value = o; w.mat.uniforms.uBias.value = 0; w.mat.uniforms.uClip.value.copy(FULL_CLIP);
    }
  }
}
// scrim for type over imagery
const scrimMat = new THREE.ShaderMaterial({
  uniforms: { uTop: { value: 0 }, uBottom: { value: 0 }, uAll: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `uniform float uTop; uniform float uBottom; uniform float uAll; varying vec2 vUv;
    void main(){ float a = uTop * smoothstep(0.62, 0.95, vUv.y) + uBottom * (1.0 - smoothstep(0.1, 0.42, vUv.y)); a = 1.0 - (1.0 - a) * (1.0 - uAll); gl_FragColor = vec4(0.0, 0.0, 0.0, a); }`,
  transparent: true, depthTest: false, depthWrite: false,
});
const scrim = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), scrimMat); scrim.frustumCulled = false; scrim.renderOrder = 0;
overlay.add(scrim);

// ============================================================ EPISODE: the words on screen + when they appear
// ------------------------------------------------------------ the words on screen
const IV = lin(0.86, 0.83, 0.77), SAND = lin(0.36, 0.33, 0.28);
const serifName = { family: 'Instrument Serif', weight: 400, size: 230, spacing: -4, y: 236, gold: true };
const placeLabel = { family: 'IBM Plex Mono', weight: 500, size: 30, spacing: 11, y: 548, color: IV };
const T = {
  hookA: new TextBlock('Africa’s original\nsavings app', { size: 100, y: 286, lineHeight: 1.04, maxWidth: 1000 }),
  hookB: new TextBlock('has *no app.*', { size: 100, y: 494, maxWidth: 1000 }),
  credit: new TextBlock('TAYO OVIOSU  ·  PAGA  ·  SUI LIVE, MIAMI 2026', { family: 'IBM Plex Mono', weight: 500, size: 23, spacing: 6, y: 196, gold: true }),
  tayo: new TextBlock('Tayo Oviosu', { family: 'Instrument Serif', weight: 400, size: 150, spacing: -2, y: 286 }),
  tayoRole: new TextBlock('FOUNDER, PAGA  ·  SUI LIVE, MIAMI 2026', { family: 'IBM Plex Mono', weight: 500, size: 24, spacing: 7, y: 482, gold: true }),
  move: new TextBlock('Move.', { size: 150, y: 286 }),
  transact: new TextBlock('Transact.', { size: 150, y: 286 }),
  save: new TextBlock('*Save.*', { size: 150, y: 286 }),
  esusu: new TextBlock('Esusu', serifName),
  njangi: new TextBlock('Njangi', serifName),
  susu: new TextBlock('Susu', serifName),
  lagos: new TextBlock('LAGOS', placeLabel),
  cameroon: new TextBlock('CAMEROON', placeLabel),
  ghana: new TextBlock('GHANA', placeLabel),
  payin: new TextBlock('*Everyone* pays in.', { size: 112, y: 300 }),
  takepot: new TextBlock('One takes *the pot.*', { size: 112, y: 300 }),
  round: new TextBlock('It goes *round.*', { size: 112, y: 300 }),
  catchH: new TextBlock('*The catch:*\nsomebody holds the pot.', { size: 92, y: 290, lineHeight: 1.08, maxWidth: 1010 }),
  nobody: new TextBlock('*Nobody* holds the pot.', { size: 124, y: 290, maxWidth: 900 }),
  tBrand: new TextBlock('Njangi On-Chain', { family: 'Instrument Serif', weight: 400, size: 150, spacing: -2, y: 1020 }),
  tTag: new TextBlock('The same circle, with less friction.', { family: 'Instrument Serif', style: 'italic', weight: 400, size: 60, spacing: 0, y: 1222, maxWidth: 980 }),
  tLink: new TextBlock('NJANGIONCHAIN.COM', { family: 'IBM Plex Mono', weight: 500, size: 24, spacing: 8, y: 1528, color: SAND }),
  cTitle: new TextBlock('Move. Transact.\n*Save.*', { family: 'Instrument Serif', weight: 400, size: 150, spacing: -3, y: 320, lineHeight: 1.0 }),
  cTag: new TextBlock('Nobody holds the pot.', { family: 'Inter Tight', weight: 600, size: 62, y: 1512, gold: true }),
  cEye: new TextBlock('AFTER SUI LIVE  ·  TAYO OVIOSU, PAGA', { family: 'IBM Plex Mono', weight: 500, size: 24, spacing: 7, y: 270, gold: true }),
};
// captions: phrase by phrase, each word lifts as it is spoken; the three big words are shown, not captioned
const BIG = new Set(['Move.', 'Transact.', 'Save.']);
const captions = [];
for (const s of SC) {
  if (s.captions === false) continue;
  for (const ch of s.chunks) {
    const ws = s.words.slice(ch.i0, ch.i1 + 1);
    const text = ws.map((w) => w.w).join(' ');
    if (BIG.has(text)) continue;
    const b = new TextBlock(text, { weight: 500, size: 44, spacing: -0.4, lineHeight: 1.22, y: 1405, maxWidth: 840, color: IV, order: 20 });
    b.times = ws.map((w) => w.t); b.a = ch.a; b.b = ch.b; b.scene = s;
    captions.push(b);
  }
}
function drawCaptions(t) {
  for (const c of captions) {
    const o = P(t, c.a, c.a + 0.22, E.outCubic) * (1 - P(t, c.b - 0.16, c.b, E.inOutSine));
    const vis = o > 0.001 && t >= c.a - 0.05 && t <= c.b + 0.05;
    c.words.forEach((w, j) => {
      w.mesh.visible = vis; if (!vis) return;
      const lift = P(t, (c.times[j] ?? c.a) - 0.05, (c.times[j] ?? c.a) + 0.14, E.lin);
      w.mesh.position.set(w.bx, -(w.by + (1 - P(t, c.a, c.a + 0.35, E.outCubic)) * 10), 0);
      w.mat.uniforms.uOpacity.value = o * lerp(0.52, 1, lift);
      w.mat.uniforms.uBias.value = 0; w.mat.uniforms.uClip.value.copy(FULL_CLIP);
    });
  }
}

function drawOverlay(t, cover) {
  for (const k in T) T[k].hide();
  for (const c of captions) c.hide();
  scrimMat.uniforms.uTop.value = 0; scrimMat.uniforms.uBottom.value = 0; scrimMat.uniforms.uAll.value = 0;
  if (cover) {
    T.cEye.fade(1, 0, null); T.cTitle.fade(1, 0, null); T.cTag.fade(1, 0, null);
    scrimMat.uniforms.uTop.value = 0.35;
    return;
  }
  // 1 · the hook (the headline is the voice line; this scene has no captions)
  T.hookA.rise(t, 0.25, M.tr0 - 0.45, { dur: 1.0 });
  T.hookB.rise(t, M.has - 0.15, M.tr0 - 0.45, { dur: 0.95 });
  // 2 · move, transact, save, credited to the talk
  T.tayo.focus(t, M.tr0 + 0.25, M.move - 0.55, { dur: 1.5, outDur: 0.4, scale0: 1.05 });
  T.tayoRole.rise(t, M.tr0 + 0.6, M.move - 0.55, { dur: 1.0, outDur: 0.35 });
  T.credit.rise(t, M.move - 0.2, M.formA + 0.3, { dur: 0.9 });   // a small credit while the three words are up
  T.move.rise(t, M.move - 0.12, M.transact - 0.32, { dur: 0.8, outDur: 0.3 });
  T.transact.rise(t, M.transact - 0.12, M.save - 0.32, { dur: 0.8, outDur: 0.3 });
  T.save.rise(t, M.save - 0.12, M.esusu - 0.5, { dur: 0.9 });
  // 3 · one circle, three names
  const names = [[T.esusu, T.lagos, M.esusu, M.njangi], [T.njangi, T.cameroon, M.njangi, M.susu], [T.susu, T.ghana, M.susu, M.p0 - 0.05]];
  for (const [nm, pl, a, b] of names) {
    nm.focus(t, a - 0.3, b - 0.42, { dur: 1.2, outDur: 0.32, scale0: 1.05 });
    pl.rise(t, a - 0.1, b - 0.42, { dur: 0.8, outDur: 0.3, sheen: false });
  }
  // 4 · the mechanics
  T.payin.rise(t, M.p0 + 0.05, M.k0 - 0.2, { outDur: 0.32 });
  T.takepot.rise(t, M.k0 + 0.05, M.o0 - 0.2, { outDur: 0.32 });
  T.round.rise(t, M.o0 + 0.05, M.c0 - 0.5);
  // 5 · the catch, 6 · nobody holds the pot
  T.catchH.rise(t, M.c0 + 0.15, M.n0 - 0.45);
  T.nobody.rise(t, M.nob - 0.12, M.ti0 - 0.55, { dur: 1.15, stagger: 0.075 });
  // 7 · the brand card
  T.tBrand.focus(t, M.brand - 0.2, null, { dur: 1.8, scale0: 1.05 });
  T.tTag.rise(t, M.same - 0.15, null, { dur: 1.0, sheen: false });
  T.tLink.fade(t, M.friction + 0.25, null, { dur: 0.7 });
  drawCaptions(t);
}

// ============================================================ ENGINE: camera (Hermite keys, aperture/sub-pixel jitter)
// ------------------------------------------------------------ camera
function orbitPos(target, az, el, dist) {
  return V3(target.x + dist * Math.sin(az * D2R) * Math.cos(el * D2R), target.y + dist * Math.sin(el * D2R), target.z + dist * Math.cos(az * D2R) * Math.cos(el * D2R));
}
// Hermite through keys with Catmull-Rom tangents: continuous velocity, no robotic stops.
function track(keys, t) {
  if (t <= keys[0].t) return { ...keys[0] };
  if (t >= keys[keys.length - 1].t) return { ...keys[keys.length - 1] };
  let i = 0; while (keys[i + 1].t < t) i++;
  const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(keys.length - 1, i + 2)];
  const u = (t - k1.t) / (k2.t - k1.t), dt = k2.t - k1.t;
  const out = { t };
  for (const ch of Object.keys(k1)) {
    if (ch === 't') continue;
    const m1 = i === 0 ? 0 : ((k2[ch] - k0[ch]) / (k2.t - k0.t)) * dt;
    const m2 = i + 2 >= keys.length ? 0 : ((k3[ch] - k1[ch]) / (k3.t - k1.t)) * dt;
    const u2 = u * u, u3 = u2 * u;
    out[ch] = (2 * u3 - 3 * u2 + 1) * k1[ch] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * k2[ch] + (u3 - u2) * m2;
  }
  return out;
}
// one continuous camera for everything after the hook: the first and second circle shots share it,
// so the dissolve between them (the end of a round -> a fresh one) is a clean change of state
const topDown = (t, az, dist) => ({ t, tx: 1.62 * Math.sin(az * D2R), ty: 0, tz: 1.62 * Math.cos(az * D2R), az, el: 89.8, dist, fov: 30, ap: 0.0 });
// the target sits a little toward the camera along its own azimuth (d), so the circle stays centred
// in frame however far the orbit swings (a fixed +z offset turns sideways at large azimuths)
const kk = (t, d, ty, az, el, dist, ap) => ({ t, tx: d * Math.sin(az * D2R), ty, tz: d * Math.cos(az * D2R), az, el, dist, fov: 30, ap });
const camKeys = [
  // low over dark water, looking out toward the horizon (the two routes)
  { t: M.tr0 - 0.6, tx: 0.0, ty: 0.12, tz: -3.0, az: 2.5, el: 8.2, dist: 6.9, fov: 30, ap: 0.006 },
  { t: M.formA, tx: 0.0, ty: 0.1, tz: -2.5, az: 4.5, el: 9.4, dist: 6.4, fov: 30, ap: 0.006 },
  // the routes gather into the circle: crane up to the house hero angle
  kk(M.formB + 0.35, 0.18, 0.06, 0, 31, 7.6, 0.012),
  // the three names: a slow drift round the circle
  kk(M.p0, 0.2, 0.06, 12, 34, 7.5, 0.013),
  // the mechanics (Ep. 1's angles)
  kk(M.k0 + 0.3, 0.22, 0.06, 16, 35, 7.5, 0.014),
  kk(M.moveB, 0.5, 0.08, 12, 27, 6.4, 0.018),
  kk(M.roundB, 0.3, 0.05, 40, 46, 8.2, 0.014),
  // the catch: lower and closer on the one who holds it
  kk(M.hold + 0.4, 0.35, 0.08, 50, 28, 7.8, 0.016),
  // nobody holds the pot: rise
  kk(M.kept + 1.6, 0.3, 0.05, 60, 38, 7.8, 0.012),
  kk(M.nob + 1.6, 0.1, 0.05, 68, 54, 8.7, 0.01),
  kk(M.ti0 - 0.3, 0.25, 0.05, 76, 62, 8.6, 0.006),
  // the brand card: straight down on the star mark, the mark in the upper third
  topDown(M.ti0 + 2.0, 86, 12.4),
  topDown(T_END + 0.5, 100, 12.8),
];
function camFromKey(k) {
  const target = V3(k.tx, k.ty, k.tz);
  const pos = orbitPos(target, k.az, k.el, k.dist);
  // near top-down the world-up vector degenerates: blend toward "away from viewer"
  const f = clamp((k.el - 80) / 9.8);
  const up = V3(0, 1, 0).lerp(V3(-Math.sin(k.az * D2R), 0, -Math.cos(k.az * D2R)), f).normalize();
  return { pos, target, up, fov: k.fov, aperture: k.ap, focus: pos.distanceTo(target) };
}

// per-sample jitter tables
const MAXN = 64;
const jit = Array.from({ length: MAXN }, (_, i) => ({ hx: halton(i + 1, 2) - 0.5, hy: halton(i + 1, 3) - 0.5 }));
let SAMPLE = 0, NSAMP = 1;
function applyCamera(st) {
  camera.fov = st.fov;
  camera.up.copy(st.up || V3(0, 1, 0));
  camera.position.copy(st.pos); camera.lookAt(st.target); camera.updateMatrixWorld(true);
  const r = Math.sqrt((SAMPLE + 0.5) / NSAMP), th = SAMPLE * 2.399963;
  const ax = r * Math.cos(th) * st.aperture, ay = r * Math.sin(th) * st.aperture;
  const right = V3(0, 0, 0).setFromMatrixColumn(camera.matrixWorld, 0), up = V3(0, 0, 0).setFromMatrixColumn(camera.matrixWorld, 1);
  camera.position.addScaledVector(right, ax).addScaledVector(up, ay); camera.updateMatrixWorld(true);
  const near = camera.near, top = near * Math.tan((st.fov / 2) * D2R), hgt = 2 * top, wid = hgt * camera.aspect;
  const sx = (-ax * near) / st.focus + (jit[SAMPLE].hx * wid) / W, sy = (-ay * near) / st.focus + (jit[SAMPLE].hy * hgt) / H;
  camera.projectionMatrix.makePerspective(-wid / 2 + sx, wid / 2 + sx, top + sy, -top + sy, near, camera.far);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  FU.uCam.value.copy(camera.position);
}
function jitterLight(light, base, radius) {
  const r = Math.sqrt((SAMPLE + 0.5) / NSAMP) * radius, th = SAMPLE * 2.399963 + 1.3;
  light.position.set(base.x + r * Math.cos(th), base.y, base.z + r * Math.sin(th));
}

// ============================================================ EPISODE: shots (what each beat looks like) + cover
const members3 = members.map(() => V3(0, 0, 0));
function ellipse(th, rx, rz, cx, cz, y, out) { return out.set(cx + rx * Math.cos(th), y, cz + rz * Math.sin(th)); }
function setMemberLook(m, litAmt, glow) {
  const mat = m.mat;
  mat.color.copy(OBSIDIAN).lerp(GOLD, litAmt);
  mat.metalness = litAmt; mat.roughness = lerp(0.13, 0.15, litAmt);
  mat.clearcoat = lerp(1, 0.25, litAmt);
  mat.emissive.copy(GOLD).multiplyScalar(glow * 0.32);
}

function commonStudio({ envI = 1, keyI = 2.0, rimI = 0.7, bgGlow = lin(0.022, 0.016, 0.011), bgBase = lin(0.0015, 0.0015, 0.002), bgCenter = [0.5, 0.52], bgRadius = 0.62 }) {
  envGlobal = envI;
  key.intensity = keyI * 0.8; key.color.set(0xfff1e0);
  rim.intensity = rimI; rim.color.set(0xcfdcff); rim.position.set(-3, 3, -5);
  spot.intensity = 0;
  bgMat.uniforms.uGlow.value.copy(bgGlow); bgMat.uniforms.uBase.value.copy(bgBase);
  bgMat.uniforms.uCenter.value.set(...bgCenter); bgMat.uniforms.uRadius.value = bgRadius;
  bg.visible = true; floor.visible = true; shadowCatcher.visible = true;
  FU.uWater.value = 0; FU.uFog.value = 0; FU.uReflect.value = 0.42; FU.uBlur.value = 3.3;
  FU.uBase.value.copy(lin(0.004, 0.004, 0.0048)); FU.uSpotColor.value.set(0, 0, 0);
  scene.fog.density = 0;
  phoneEnvRot(0);
}

// ---- shot 1: the hook. A phone lying dark on the studio floor; the softboxes slide across its glass.
function shotPhone(t) {
  phoneG.visible = true; circleG.visible = false; oceanG.visible = false;
  commonStudio({ envI: 0.6, keyI: 1.2, rimI: 1.3, bgGlow: lin(0.018, 0.013, 0.009), bgCenter: [0.5, 0.45], bgRadius: 0.62 });
  lightBase.key.set(-1.4, 6.0, -3.2); key.target.position.set(0, 0, 0);
  rim.position.set(3.0, 2.2, -3.5); rim.color.setRGB(1.0, 0.86, 0.68);
  FU.uSpotColor.value.copy(lin(0.032, 0.023, 0.014)); FU.uSpot.value.set(0, 0, 0, 1.35);
  phoneEnvRot(lerp(-0.3, 0.6, P(t, 0, M.tr0 + 0.3, E.inOutSine)));   // the band glides across the glass around "has no app"
  const q = P(t, 0, M.tr0 + 0.6, E.inOutSine);
  const az = lerp(14, 6, q), el = lerp(42, 36, q), dist = lerp(4.7, 4.2, q), back = 0.35;   // aim past the phone so it sits low, under the type
  const cam = camFromKey({ tx: -back * Math.sin(az * D2R), ty: 0.03, tz: 0.05 - back * Math.cos(az * D2R), az, el, dist, fov: 30, ap: 0.016 });
  return { cam, post: { bloom: 0.24, exposure: 1.0 } };
}

// ---- shots 2-4 (first) and 5-7 (second): the routes that become the circle, then the circle
function shotCircle(t, second) {
  phoneG.visible = false; circleG.visible = true;
  const crossing = !second && t < M.formB + 0.3;
  oceanG.visible = crossing;
  const rx = R, rz = R, cx = 0, cz = 0;
  // dark water under the routes; it stills to the studio floor as the circle forms
  const ocean = second ? 0 : 1 - P(t, M.formA + 0.2, M.formB + 0.3, E.inOutSine);
  // light: cool over the water, warm in the circle; the catch cools it a little, "kept" warms it back
  const warmth = second ? lerp(0.5, 1, P(t, M.kept, M.nob + 1.0, E.inOutSine)) : 1 - ocean;
  const cool = 1 - warmth;
  commonStudio({
    envI: lerp(1.0, 0.7, cool) + 0.15 * (second ? P(t, M.nob, M.nob + 1.5) : 0),
    keyI: lerp(2.1, 1.5, cool), rimI: lerp(0.7, 1.1, cool),
    bgGlow: second
      ? lin(lerp(0.024, 0.006, cool), lerp(0.017, 0.009, cool), lerp(0.011, 0.016, cool))
      : lin(lerp(0.024, 0.03, ocean), lerp(0.017, 0.016, ocean), lerp(0.011, 0.01, ocean)),
    bgBase: second ? lin(0.0015, 0.0015, 0.002) : lin(0.0015, lerp(0.0015, 0.002, ocean), lerp(0.002, 0.0045, ocean)),
    bgCenter: second ? [0.5, t > M.ti0 ? lerp(0.52, 0.66, P(t, M.ti0, M.ti0 + 1.8)) : 0.52] : [0.5, lerp(0.52, 0.36, ocean)],
    bgRadius: second ? 0.62 : lerp(0.62, 0.5, ocean),
  });
  key.color.setRGB(lerp(1, 0.78, ocean), lerp(0.95, 0.9, cool), lerp(0.88, 1.0, cool));
  lightBase.key.set(lerp(2.2, -2.6, ocean), 6, lerp(3.4, -5.0, ocean));
  key.target.position.set(0, 0, 0);
  FU.uWater.value = ocean; FU.uTime.value = t;
  FU.uBase.value.copy(lin(0.004, 0.004, 0.0048)).lerp(lin(0.003, 0.006, 0.011), ocean);
  FU.uFog.value = 0.09 * ocean; FU.uFogColor.value.copy(lin(0.002, 0.003, 0.006));
  scene.fog.color.copy(lin(0.002, 0.003, 0.006)); scene.fog.density = 0.035 * ocean;
  FU.uSpotColor.value.copy(lin(0.05, 0.036, 0.021)).multiplyScalar((1 - 0.7 * cool) * (1 - ocean)); FU.uSpot.value.set(0, 0, 0, 1.9);

  // ---------- the ring (and, over the water, the two routes it is made from)
  const ringY = 0.023;
  const bulge = second ? pulseWin(t, M.nob + 0.55, 0.25, 0.1, 0.9) : 0;
  const ringR = (s) => 0.023 * (1 + 0.5 * bulge);
  if (!second && t < M.formB) {
    const d1 = P(t, M.mvA, M.mvB, E.inOutSine), d2 = P(t, M.trA, M.trB, E.inOutSine);
    const rr = lerp(0.02, 0.023, P(t, M.formA, M.formB, E.inOutSine));
    const tipAt = (tip, curve, d) => { tip.visible = d > 0.002 && d < 0.998; if (tip.visible) tip.position.copy(curve.getPointAt(d)); };
    tipAt(tips[0], ROUTE_MOVE, d1); tipAt(tips[1], ROUTE_BACK, d2);
    const tmp = V3(0, 0, 0);
    const g1 = (s, out) => {                 // route 1, near -> far, becomes the right half (front -> back)
      const a = ROUTE_MOVE.getPointAt(clamp(s));
      const lag = 0.45 * (1 - s);            // the far end sets off first: it has the longest trip
      const w = P(t, M.formA + lag, M.formA + lag + 1.35, E.inOutCubic);
      ellipse(Math.PI / 2 - s * Math.PI, R, R, 0, 0, ringY, tmp);
      return out.copy(a).lerp(tmp, w);
    };
    const g2 = (s, out) => {                 // route 2, far -> near, becomes the left half (back -> front)
      const a = ROUTE_BACK.getPointAt(clamp(s));
      const lag = 0.45 * s;
      const w = P(t, M.formA + lag, M.formA + lag + 1.35, E.inOutCubic);
      ellipse(-Math.PI / 2 - s * Math.PI, R, R, 0, 0, ringY, tmp);
      return out.copy(a).lerp(tmp, w);
    };
    ring.update(g1, 0, Math.max(d1, 1e-4), () => rr, false);
    route2.group.visible = true;
    route2.update(g2, 0, Math.max(d2, 1e-4), () => rr, false);
  } else {
    ring.update((s, out) => ellipse(Math.PI / 2 + s * 2 * Math.PI, rx, rz, cx, cz, ringY, out), 0, 1, ringR, true);
    route2.group.visible = false;
  }
  worldWord.visible = false;

  // ---------- the routes' end points: lit as each line reaches them, gone as they gather
  if (crossing) {
    const litAt = [M.mvA, M.mvB - 0.15, M.trA, M.trB - 0.15];
    const gone = P(t, M.formA - 0.1, M.formA + 0.7, E.inOutCubic);
    routeNodes.forEach((n, i) => {
      const on = P(t, litAt[i] - 0.1, litAt[i] + 0.35, E.outBack);
      n.scale.setScalar(Math.max(1e-4, on * (1 - gone)));
      n.material.emissive.copy(GOLD).multiplyScalar(0.35 * pulseWin(t, litAt[i] - 0.05, 0.15, 0.1, 0.9));
      placePulse(routePulses[i], ROUTE_NODES[i].x, ROUTE_NODES[i].z, t, litAt[i] - 0.02, 0.06, 0.3, 1.0, 0.9);
    });
  }

  // ---------- members
  const lit = Array(NM).fill(0), glow = Array(NM).fill(0), scale = Array(NM).fill(1);
  for (let i = 0; i < NM; i++) {
    if (!second) scale[i] = P(t, M.memA + i * 0.075, M.memA + i * 0.075 + 0.7, E.outBack);
    ellipse(theta(i), rx, rz, cx, cz, MR, members3[i]);
  }
  const potC = V3(0, 0.24, 0);
  let potR = 0, potX = potC.clone(), potVis = 0;
  if (!second) {
    // one circle, three names: a ring of light leaves the circle on each name
    const nameT = [M.esusu, M.njangi, M.susu];
    let nameGlow = 0;
    namePulses.forEach((p, k) => {
      placePulse(p, 0, 0, t, nameT[k] - 0.05, 1.0, 1.45, 1.6, 0.45);
      nameGlow += pulseWin(t, nameT[k] - 0.08, 0.18, 0.1, 0.9);
    });
    // pay-in: beads arc into the centre and become the pot
    let arrived = 0;
    beads.forEach((bd, i) => {
      const a = M.flow + i * 0.075, u = P(t, a, a + 0.85, E.inOutCubic);
      const from = members3[i];
      bd.visible = u > 0 && u < 1 && t < M.k0 + 1;
      bd.position.set(lerp(from.x, potC.x, u), lerp(from.y, potC.y, u) + Math.sin(Math.PI * u) * 0.42, lerp(from.z, potC.z, u));
      arrived += P(t, a + 0.75, a + 0.9, E.outCubic) / NM;
    });
    if (t >= M.flow && t < M.liftA + 1e-3) { potR = 0.2 * Math.cbrt(arrived); potVis = 1; }
    // one takes the pot: lift, glide to member 0, pour into it
    const lift = P(t, M.liftA, M.liftA + 0.45, E.outCubic);
    const mv = P(t, M.moveA, M.moveB, E.inOutCubic);
    const into = P(t, M.moveB - 0.12, M.moveB + 0.3, E.inOutCubic);
    if (t >= M.liftA) {
      const dest = members3[0];
      potX.set(lerp(potC.x, dest.x, mv), lerp(potC.y + 0.08 * lift, dest.y + 0.02, mv) + Math.sin(Math.PI * mv) * 0.25, lerp(potC.z, dest.z, mv));
      potR = 0.2 * lerp(1, 0.55, mv) * (1 - into); potVis = 1;
    }
    lit[0] = into; glow[0] = pulseWin(t, M.moveB - 0.05, 0.12, 0.1, 0.9);
    // it goes round
    const pr = P(t, M.roundA, M.roundB, E.inOutSine);
    for (let i = 1; i < NM; i++) {
      const ti = M.roundA + (Math.acos(1 - 2 * (i / NM)) / Math.PI) * (M.roundB - M.roundA);
      lit[i] = P(t, ti - 0.08, ti + 0.2, E.outCubic);
      glow[i] = pulseWin(t, ti - 0.05, 0.12, 0.05, 0.8);
      placePulse(pulses[i], members3[i].x, members3[i].z, t, ti - 0.02);
    }
    placePulse(pulses[0], members3[0].x, members3[0].z, t, M.moveB);
    placePulse(pulses[NM], 0, 0, t, M.roundB - 0.05, 0.9, 1.25, 1.3, 0.8);
    pulses[NM + 1].visible = false;
    if (pr > 0 && pr < 1) {
      glowRing.group.visible = true;
      const a = Math.max(0, pr - 0.22), b = pr;
      glowRing.update((s, out) => ellipse(theta(0) + s * 2 * Math.PI, R, R, 0, 0, ringY, out), a, b, (s) => 0.022 * P(s, a, b, E.inOutSine), false);
      glowMat.opacity = 1;
    } else glowRing.group.visible = false;
    const flash = pulseWin(t, M.roundB - 0.1, 0.25, 0.1, 1.0);
    ringMat.emissive.copy(GOLD).multiplyScalar(0.22 * flash + 0.12 * nameGlow);
    for (const s of spokes) s.visible = false;
    for (const c of chords) c.visible = false;
  } else {
    for (const bd of beads) bd.visible = false;
    for (const p of namePulses) p.visible = false;
    glowRing.group.visible = false;
    for (const p of pulses) p.visible = false;
    // a fresh round: the pot settles on one member (the holder = member 0, nearest us)
    const hold = P(t, M.someone + 0.05, M.someone + 1.0, E.inOutCubic);
    const back = P(t, M.kept + 0.1, M.kept + 1.1, E.inOutCubic);
    const holderLift = hold * (1 - back);
    const hpos = members3[0].clone().add(V3(0, 0.1 * holderLift, 0));
    members3[0].copy(hpos);
    scale[0] = 1 + 0.35 * holderLift;
    const onHolder = hpos.clone().add(V3(0, MR * scale[0] + 0.13, 0));
    potVis = 1 - P(t, M.nob - 0.1, M.nob + 0.15, E.lin);
    potR = 0.13;
    const p1 = V3(0, 0.24, 0);
    if (t < M.kept + 0.1) potX.copy(p1).lerp(onHolder, hold); else potX.copy(onHolder).lerp(p1, back);
    potX.y += Math.sin(Math.PI * hold) * 0.18 * (1 - back) + Math.sin(Math.PI * back) * 0.15;
    // every other member's thread runs through the one who holds it
    const retract = P(t, M.kept - 0.1, M.kept + 0.6, E.inOutCubic);
    for (let i = 0; i < NM; i++) {
      if (i === 0) { spokes[i].visible = false; continue; }
      const d = P(t, M.hold + 0.05 + i * 0.05, M.hold + 0.7 + i * 0.05, E.inOutCubic) * (1 - retract);
      placeThread(spokes[i], members3[i].clone(), hpos.clone(), d, 0.0045, 0.85);
    }
    // nobody holds the pot: every member tied to every other
    placePulse(pulses[NM], 0, 0, t, M.nob - 0.05, 0.05, 1.0, 0.75, 1.2);
    placePulse(pulses[NM + 1], 0, 0, t, M.nob + 0.55, 0.95, 1.35, 1.2, 0.7);
    const ms = M.nob + 0.5;
    for (let i = 0; i < NM; i++) {
      const j = (i + 3) % NM;
      const d = P(t, ms + i * 0.07, ms + i * 0.07 + 0.95, E.inOutCubic);
      const shimmer = 1 + 0.9 * pulseWin(t, M.even - 0.05 + i * 0.03, 0.15, 0.05, 0.7);
      placeThread(chords[i], members3[i].clone().setY(MR * 0.55), members3[j].clone().setY(MR * 0.55), d, 0.0036, 0.75 * shimmer);
      lit[i] = P(t, ms + i * 0.07 + 0.25, ms + i * 0.07 + 0.75, E.outCubic);
      glow[i] = pulseWin(t, ms + i * 0.07 + 0.2, 0.15, 0.05, 0.8) * 0.8;
    }
    const flash = pulseWin(t, M.nob + 0.55, 0.25, 0.15, 1.2);
    ringMat.emissive.copy(GOLD).multiplyScalar(0.25 * flash + 0.15 * bulge);
  }
  for (let i = 0; i < NM; i++) {
    const m = members[i];
    m.mesh.position.copy(members3[i]);
    m.mesh.scale.setScalar(Math.max(1e-4, scale[i]));
    m.mesh.visible = scale[i] > 0.001;
    setMemberLook(m, lit[i], glow[i]);
  }
  orb.visible = potR > 0.002 && potVis > 0.01;
  orb.position.copy(potX); orb.scale.setScalar(Math.max(1e-4, potR));
  orbMat.emissive.copy(GOLD).multiplyScalar(0.03 + 0.1 * (second ? 0 : pulseWin(t, M.liftA, 0.3, 0.3, 0.6)));

  const k = track(camKeys, t);
  const roundBloom = P(t, M.roundA, M.roundB) * (1 - P(t, M.roundB, M.roundB + 0.9, E.inOutSine));
  return { cam: camFromKey(k), post: { bloom: 0.22 + 0.1 * (second ? P(t, M.nob, M.nob + 1) : roundBloom), exposure: lerp(0.95, 0.9, cool) } };
}

// ---- which shots are on screen: dissolves throughout
const XF = 1.0;
function shotsAt(t) {
  const first = (tt) => shotCircle(tt, false), second = (tt) => shotCircle(tt, true);
  const mix = (a, b, x) => { const w = E.inOutSine((t - (x - XF / 2)) / XF); return [{ f: a, w: 1 - w }, { f: b, w }]; };
  const a = M.tr0, c = M.c0;
  if (t < a - XF / 2) return [{ f: shotPhone, w: 1 }];
  if (t < a + XF / 2) return mix(shotPhone, first, a);
  if (t < c - XF / 2) return [{ f: first, w: 1 }];
  if (t < c + XF / 2) return mix(first, second, c);
  return [{ f: second, w: 1 }];
}
function coverShot() {
  shotCircle(M.nob + 2.6, true);
  const cam = camFromKey({ tx: 0, ty: 0.05, tz: -0.25, az: 8, el: 58, dist: 9.2, fov: 30, ap: 0.008 });
  return { cam, post: { bloom: 0.26, exposure: 0.98 } };
}

// the word texture for the 3D "tontine" (Ep. 1 only; kept so the engine boot is unchanged)
let WORD = null;

// ============================================================ ENGINE: accumulation, post (bloom, ACES, grain), frame contract
// ------------------------------------------------------------ render targets + post
const rtOpts = { type: THREE.HalfFloatType, depthBuffer: true };
const subRT = new THREE.WebGLRenderTarget(W, H, rtOpts);
const accRT = new THREE.WebGLRenderTarget(W, H, { type: floatBlend ? THREE.FloatType : THREE.HalfFloatType, depthBuffer: false });
const accMat = new THREE.ShaderMaterial({
  uniforms: { tSub: { value: null }, uW: { value: 1 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: 'uniform sampler2D tSub; uniform float uW; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(tSub, vUv).rgb * uW, 1.0); }',
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
  depthTest: false, depthWrite: false,
});
const fsScene = new THREE.Scene(), fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), accMat); fsQuad.frustumCulled = false; fsScene.add(fsQuad);

const composer = new EffectComposer(renderer);
composer.setPixelRatio(1); composer.setSize(W, H);
const texPass = new TexturePass(accRT.texture);
const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.25, 0.45, 1.3);
const FinalShader = {
  uniforms: { tDiffuse: { value: null }, uExposure: { value: 1 }, uSeed: { value: 0 }, uFade: { value: 1 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uExposure; uniform float uSeed; uniform float uFade; varying vec2 vUv;
    vec3 RRTAndODTFit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
    vec3 aces(vec3 c){
      const mat3 IN = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
      const mat3 OUT = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
      c *= uExposure / 0.6; c = IN * c; c = RRTAndODTFit(c); c = OUT * c; return clamp(c, 0.0, 1.0); }
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uSeed) * 43758.5453); }
    vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    void main(){
      vec2 d = vUv - 0.5; float r2 = dot(d * vec2(0.5625, 1.0), d * vec2(0.5625, 1.0));
      vec2 off = d * r2 * 0.012;
      vec3 c = vec3(texture2D(tDiffuse, vUv - off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv + off).b);
      c = aces(c);
      c *= 1.0 - smoothstep(0.08, 0.42, r2) * 0.32;
      vec3 s = toSRGB(c);
      float lum = dot(s, vec3(0.299, 0.587, 0.114));
      float g = (hash(vUv * vec2(1080.0, 1920.0)) - 0.5) * 0.042 * (0.35 + 0.65 * (1.0 - abs(lum - 0.45) * 1.6));
      s += g + (hash(vUv * 731.0 + 3.1) - 0.5) / 255.0;
      gl_FragColor = vec4(s * uFade, 1.0);
    }`,
};
const finalPass = new ShaderPass(FinalShader);
composer.addPass(texPass); composer.addPass(bloom); composer.addPass(finalPass);
finalPass.renderToScreen = true;

// ------------------------------------------------------------ frame
function renderFrame(t, N, cover = false) {
  NSAMP = Math.min(N, MAXN);
  renderer.setRenderTarget(accRT); renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false);
  const shutter = 0.5 / FPS;
  let post = null;
  for (let i = 0; i < NSAMP; i++) {
    SAMPLE = i;
    const ti = cover ? t : t + ((i + 0.5) / NSAMP - 0.5) * shutter;
    const list = cover ? [{ f: () => coverShot(), w: 1 }] : shotsAt(ti);
    drawOverlay(ti, cover);
    for (const { f, w } of list) {
      if (w <= 0.0005) continue;
      const r = f(ti);
      if (!post || w >= 0.5) post = r.post;
      applyEnv();
      jitterLight(key, lightBase.key, 0.35);
      jitterLight(spot, lightBase.spot, 0.12);
      applyCamera(r.cam);
      renderer.setRenderTarget(subRT); renderer.setClearColor(0x000000, 1); renderer.clear(true, true, true);
      renderer.render(scene, camera);
      renderer.clearDepth();
      renderer.render(overlay, ortho);
      accMat.uniforms.tSub.value = subRT.texture; accMat.uniforms.uW.value = w / NSAMP;
      renderer.setRenderTarget(accRT); renderer.render(fsScene, fsCam);
    }
  }
  bloom.strength = post.bloom; bloom.radius = 0.45; bloom.threshold = 1.3;
  finalPass.uniforms.uExposure.value = post.exposure;
  finalPass.uniforms.uSeed.value = (Math.floor(t * FPS) % 997) * 0.731;
  finalPass.uniforms.uFade.value = cover ? 1 : P(t, 0.0, 0.6, E.inOutSine);   // 008: opens on a hook
  renderer.setRenderTarget(null);
  composer.render();
}

const pixels = new Uint8Array(W * H * 4);
window.__frame = async (t, N = 16) => {
  renderFrame(t, N, t < 0);
  renderer.setRenderTarget(null);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(new Blob([pixels])); });
};

// ------------------------------------------------------------ boot
try {
  const wordTx = wordTexture('tontine', 'italic 400 300px "Instrument Serif"', -4);
  WORD = { w: 1.3, h: (1.3 * wordTx.h) / wordTx.w };
  worldWordMat.uniforms.map.value = wordTx.tex;
  renderer.compile(scene, camera);
  window.__ready = true;
} catch (e) {
  window.__failed = String(e && e.stack || e);
}

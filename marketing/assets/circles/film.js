// Circles of the World: the film engine (series look, Ep. 1 The Tontine).
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
  // rewrite: the strike-through becomes the circle
  r0: VIS.rewrite.t0, opp: wt('rewrite', 'opposite'), every: wt('rewrite', 'everyone'),
  // payin / takepot / round
  p0: VIS.payin.t0, flow: wt('payin', 'everyone') - 0.12,
  k0: VIS.takepot.t0, takes: wt('takepot', 'takes'), whole: wt('takepot', 'whole'),
  o0: VIS.round.t0, round: wt('round', 'round'), turn: wt('round', 'turn'),
  d0: VIS.plate.t0, ten: wt('plate', 'ten'), nob1: wt('plate', 'no', 0), nob2: wt('plate', 'no', 1), just: wt('plate', 'just'),
  c0: VIS.catch.t0, someone: wt('catch', 'someone'), hold: wt('catch', 'hold'), stretch: wt('catch', 'stretches'),
  n0: VIS.nobody.t0, kept: wt('nobody', 'kept'), nob: wt('nobody', 'nobody', 0), rules: wt('nobody', 'rules'),
  ti0: VIS.title.t0, circles: wt('title', 'circles'), next: wt('title', 'next'), link: wt('title', 'link'),
};
M.strikeA = M.opp - 0.3; M.strikeB = M.opp + 0.3;
M.bendA = M.opp + 0.5; M.bendB = M.bendA + 1.6;
M.tipA = M.bendA + 1.1; M.tipB = M.tipA + 1.5;
M.memA = Math.max(M.every - 0.1, M.tipB - 0.5);
M.liftA = M.takes - 0.15; M.moveA = Math.max(M.whole - 0.1, M.liftA + 0.4); M.moveB = M.moveA + 0.95;
M.roundA = M.round - 0.12; M.roundB = Math.max(M.turn + 0.35, M.roundA + 2.8);

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
const coinsG = new THREE.Group(), circleG = new THREE.Group(), clothG = new THREE.Group();
scene.add(coinsG, circleG, clothG);

// ============================================================ EPISODE: scene 1 set (coins, 1653)
function canvasTex(size, draw, { srgb = false, repeat = null } = {}) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  t.anisotropy = 8;
  return t;
}
function heightToNormal(src, strength) {
  const n = src.width, g = src.getContext('2d').getImageData(0, 0, n, n).data;
  const c = document.createElement('canvas'); c.width = c.height = n;
  const ctx = c.getContext('2d'); const img = ctx.createImageData(n, n);
  const H_ = (x, y) => g[(((y + n) % n) * n + ((x + n) % n)) * 4] / 255;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = (H_(x + 1, y) - H_(x - 1, y)) * strength, dy = (H_(x, y + 1) - H_(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1), i = (y * n + x) * 4;
    img.data[i] = ((-dx / l) * 0.5 + 0.5) * 255; img.data[i + 1] = ((dy / l) * 0.5 + 0.5) * 255; img.data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.anisotropy = 8; return t;
}
// coin face relief: raised rim, beaded border, a sunburst (no real coin design)
const faceHeight = (() => {
  const n = 1024, c = document.createElement('canvas'); c.width = c.height = n;
  const g = c.getContext('2d'); const cx = n / 2;
  g.fillStyle = '#6a6a6a'; g.fillRect(0, 0, n, n);
  const ring = (r0, r1, col) => { g.beginPath(); g.arc(cx, cx, r1, 0, 2 * Math.PI); g.arc(cx, cx, r0, 0, 2 * Math.PI, true); g.fillStyle = col; g.fill(); };
  ring(462, 512, '#e0e0e0'); ring(440, 462, '#8a8a8a');
  for (let i = 0; i < 96; i++) { const a = (i / 96) * 2 * Math.PI; g.beginPath(); g.arc(cx + 418 * Math.cos(a), cx + 418 * Math.sin(a), 8, 0, 2 * Math.PI); g.fillStyle = '#c8c8c8'; g.fill(); }
  ring(380, 392, '#a6a6a6');
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * 2 * Math.PI, w = i % 2 ? 0.035 : 0.06, r1 = i % 2 ? 250 : 330;
    g.beginPath(); g.moveTo(cx + 96 * Math.cos(a - w), cx + 96 * Math.sin(a - w)); g.lineTo(cx + r1 * Math.cos(a), cx + r1 * Math.sin(a)); g.lineTo(cx + 96 * Math.cos(a + w), cx + 96 * Math.sin(a + w));
    g.fillStyle = i % 2 ? '#a0a0a0' : '#bdbdbd'; g.fill();
  }
  const rg = g.createRadialGradient(cx, cx, 0, cx, cx, 92); rg.addColorStop(0, '#f0f0f0'); rg.addColorStop(1, '#b0b0b0');
  g.beginPath(); g.arc(cx, cx, 92, 0, 2 * Math.PI); g.fillStyle = rg; g.fill();
  const blur = document.createElement('canvas'); blur.width = blur.height = n; const bg2 = blur.getContext('2d');
  bg2.filter = 'blur(2.5px)'; bg2.drawImage(c, 0, 0);
  return blur;
})();
const faceNormal = heightToNormal(faceHeight, 4);
const edgeNormal = canvasTex(512, (g, n) => { for (let x = 0; x < n; x++) { const v = 128 + 110 * Math.sin((x / n) * Math.PI * 2 * 90); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, 0, 1, n); } });
const edgeN = heightToNormal(edgeNormal.image, 3);
const agedRough = canvasTex(512, (g, n) => { g.fillStyle = '#707070'; g.fillRect(0, 0, n, n); for (let i = 0; i < 2600; i++) { const v = 90 + Math.random() * 90; g.fillStyle = `rgba(${v},${v},${v},0.35)`; g.beginPath(); g.arc(Math.random() * n, Math.random() * n, 1 + Math.random() * 7, 0, 2 * Math.PI); g.fill(); } });
const COIN_R = 0.16, COIN_T = 0.022, NCOIN = 8;
// the line recedes left and away; the camera sits off to the right so every coin shows
const COIN_ROW = (i) => new THREE.Vector3(0.18 - 0.235 * i, 0, 0.55 - 0.66 * i);
const COIN_CAM = new THREE.Vector3(0.56, 0.32, 2.8);
const COIN_YAW = (i) => { const c = COIN_ROW(i); return Math.atan2(COIN_CAM.x - c.x, COIN_CAM.z - c.z); };
const coins = [];
for (let i = 0; i < NCOIN; i++) {
  const faceM = env(new THREE.MeshPhysicalMaterial({ color: GOLD_OLD.clone(), metalness: 1, roughness: 0.34, roughnessMap: agedRough, normalMap: faceNormal, normalScale: new THREE.Vector2(0.75, 0.75) }), 1.0);
  const sideM = env(new THREE.MeshPhysicalMaterial({ color: GOLD_OLD.clone(), metalness: 1, roughness: 0.28, normalMap: edgeN, normalScale: new THREE.Vector2(0.7, 0.7) }), 1.0);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(COIN_R, COIN_R, COIN_T, 128, 1), [sideM, faceM, faceM]);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.rotation.x = Math.PI / 2;               // face toward +z (the camera)
  mesh.position.set(0, COIN_R, COIN_T / 2);    // pivot = back bottom edge, on the floor
  const pivot = new THREE.Group(); pivot.add(mesh);
  pivot.position.copy(COIN_ROW(i));
  pivot.rotation.order = 'YXZ';   // tip over about the coin's own axis, after turning to the lens
  pivot.rotation.y = COIN_YAW(i);
  coinsG.add(pivot);
  faceM.envMap = ENV_COINS; sideM.envMap = ENV_COINS;
  coins.push({ pivot, mesh, mats: [faceM, sideM] });
}

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

// ============================================================ EPISODE: scene 6 set (wax-print cloth, Douala)
const waxTex = canvasTex(2048, (g, n) => {
  g.fillStyle = '#18234e'; g.fillRect(0, 0, n, n);
  const med = (cx, cy) => {
    const disk = (r, col) => { g.beginPath(); g.arc(cx, cy, r, 0, 2 * Math.PI); g.fillStyle = col; g.fill(); };
    const ring_ = (r, w, col) => { g.beginPath(); g.arc(cx, cy, r, 0, 2 * Math.PI); g.lineWidth = w; g.strokeStyle = col; g.stroke(); };
    disk(228, '#d9a441'); disk(200, '#18234e'); disk(186, '#b44e27'); ring_(150, 12, '#efe1c2');
    for (let i = 0; i < 8; i++) { const a = (i / 8) * 2 * Math.PI - Math.PI / 2; const x = cx + 118 * Math.cos(a), y = cy + 118 * Math.sin(a);
      g.beginPath(); g.arc(x, y, 21, 0, 2 * Math.PI); g.fillStyle = '#efe1c2'; g.fill(); g.beginPath(); g.arc(x, y, 8, 0, 2 * Math.PI); g.fillStyle = '#18234e'; g.fill(); }
    disk(74, '#1f5a52'); ring_(50, 9, '#d9a441'); disk(20, '#efe1c2');
  };
  for (let y = -1; y <= 4; y++) for (let x = -1; x <= 4; x++) med(x * 512 + 256 + (y % 2 ? 256 : 0), y * 512 + 256);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) {
    const cx = x * 256 + (y % 2 ? 0 : 128), cy = y * 512 + 512;
    g.beginPath(); g.moveTo(cx, cy - 34); g.lineTo(cx + 22, cy); g.lineTo(cx, cy + 34); g.lineTo(cx - 22, cy); g.closePath(); g.fillStyle = '#2f7a6f'; g.fill();
  }
  // print imperfection: faint mottling so it reads as dyed cotton, not vector art
  for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(${Math.random() > 0.5 ? '255,240,210' : '0,0,20'},${0.018 + Math.random() * 0.03})`; g.fillRect(Math.random() * n, Math.random() * n, 2 + Math.random() * 10, 1 + Math.random() * 3); }
}, { srgb: true, repeat: [3.2, 3.2] });
const weaveH = (() => { const n = 128, c = document.createElement('canvas'); c.width = c.height = n; const g = c.getContext('2d');
  const img = g.createImageData(n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const u = Math.sin((x / n) * Math.PI * 2 * 8), v = Math.sin((y / n) * Math.PI * 2 * 8); const over = (Math.floor(x / 8) + Math.floor(y / 8)) % 2; const hgt = 128 + 90 * (over ? u * u : v * v) - 40; const i = (y * n + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = hgt; img.data[i + 3] = 255; }
  g.putImageData(img, 0, 0); return c; })();
const weaveN = heightToNormal(weaveH, 2.5); weaveN.wrapS = weaveN.wrapT = THREE.RepeatWrapping; weaveN.repeat.set(70, 70);
const clothTime = { value: 0 };
const clothMat = env(new THREE.MeshPhysicalMaterial({ map: waxTex, normalMap: weaveN, normalScale: new THREE.Vector2(0.45, 0.45), roughness: 0.8, sheen: 0.7, sheenRoughness: 0.45, sheenColor: lin(1.0, 0.8, 0.55), side: THREE.DoubleSide }), 0.6);
clothMat.onBeforeCompile = (sh) => {
  sh.uniforms.uTime = clothTime;
  sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader
    .replace('#include <beginnormal_vertex>', `
      float amp = 0.06;
      float hang = 0.55 + 0.45 * (1.0 - smoothstep(-1.0, 2.8, position.y));
      // vertical folds (the drape) + slow travelling wind
      float f1 = position.x * 7.6 + 0.6 * sin(position.y * 0.9 + uTime * 0.35);
      float p2 = position.y * 1.1 - uTime * 0.55 + position.x * 0.5, p3 = (position.x * 0.8 - position.y) * 2.6 + uTime * 1.1;
      float p1 = f1;
      float dzdx = amp * hang * (2.2 * 7.6 * cos(f1) + 0.9 * 0.5 * cos(p2) + 0.2 * 0.8 * 2.6 * cos(p3));
      float dzdy = amp * hang * (2.2 * 0.6 * 0.9 * cos(f1) * cos(position.y * 0.9 + uTime * 0.35) + 0.9 * 1.1 * cos(p2) - 0.2 * 2.6 * cos(p3));
      vec3 objectNormal = normalize(vec3(-dzdx, -dzdy, 1.0));
      #ifdef USE_TANGENT
      vec3 objectTangent = vec3(tangent.xyz);
      #endif`)
    .replace('#include <begin_vertex>', `
      vec3 transformed = vec3(position);
      transformed.z += amp * hang * (2.2 * sin(p1) + 0.9 * sin(p2) + 0.2 * sin(p3));`);
};
const cloth = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 6.2, 320, 300), clothMat);
cloth.receiveShadow = true;
cloth.position.set(0, 1.6, 0);
clothG.add(cloth);

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
  fade(t, tin, tout, { dur = 0.5, rise = 10 } = {}) {
    const o = P(t, tin, tin + dur, E.inOutSine) * (tout == null ? 1 : 1 - P(t, tout, tout + dur, E.inOutSine));
    const dy = (1 - P(t, tin, tin + dur * 1.4, E.outCubic)) * rise;
    for (const w of this.words) {
      w.mesh.visible = o > 0.001;
      if (!w.mesh.visible) continue;
      w.mesh.position.set(w.bx, -(w.by + dy), 0); w.mesh.scale.setScalar(1);
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
const T = {
  eyebrow: new TextBlock('CIRCLES OF THE WORLD · NO. 1', { family: 'IBM Plex Mono', weight: 500, size: 24, spacing: 7, y: 196, gold: true }),
  year: new TextBlock('1653', { family: 'Instrument Serif', weight: 400, size: 400, spacing: -8, y: 238, gold: true }),
  france: new TextBlock('France.', { family: 'Instrument Serif', style: 'italic', weight: 400, size: 74, spacing: 0, y: 652, color: IV }),
  rewrote: new TextBlock('Africa *rewrote* it.', { size: 112, y: 300 }),
  payin: new TextBlock('*Everyone* pays in.', { size: 112, y: 300 }),
  takepot: new TextBlock('One takes *the pot.*', { size: 112, y: 300 }),
  round: new TextBlock('It goes *round.*', { size: 112, y: 300 }),
  douala: new TextBlock('Douala, Cameroon.', { family: 'Instrument Serif', weight: 400, size: 122, spacing: -1, y: 300, maxWidth: 1000 }),
  cfa: new TextBlock('10,000 FCFA  ·  EVERY MONDAY', { family: 'IBM Plex Mono', weight: 500, size: 27, spacing: 6, y: 468, gold: true }),
  noBank: new TextBlock('No bank.', { size: 150, y: 830 }),
  noPaper: new TextBlock('No paperwork.', { size: 150, y: 830 }),
  trust: new TextBlock('Just *trust.*', { size: 150, y: 830 }),
  catchH: new TextBlock('*The catch:*\nsomeone holds the pot.', { size: 92, y: 290, lineHeight: 1.08, maxWidth: 1010 }),
  nobody: new TextBlock('*Nobody* holds the pot.', { size: 128, y: 290, maxWidth: 900 }),
  tTitle: new TextBlock('Circles\nof the World', { family: 'Instrument Serif', weight: 400, size: 164, spacing: -2, y: 1000, lineHeight: 0.98 }),
  tEp: new TextBlock('NO. 1  ·  THE TONTINE', { family: 'IBM Plex Mono', weight: 500, size: 26, spacing: 9, y: 1352, gold: true }),
  tNext: new TextBlock('Next week: the Susu', { family: 'Instrument Serif', style: 'italic', weight: 400, size: 76, spacing: 0, y: 1418 }),
  tLink: new TextBlock('LINK IN BIO  ·  NJANGIONCHAIN.COM', { family: 'IBM Plex Mono', weight: 500, size: 23, spacing: 5, y: 1528, color: SAND }),
  cTitle: new TextBlock('The Tontine', { family: 'Instrument Serif', weight: 400, size: 200, spacing: -3, y: 350 }),
  cTag: new TextBlock('Nobody holds the pot.', { family: 'Inter Tight', weight: 600, size: 62, y: 1478, gold: true }),
  cEye: new TextBlock('CIRCLES OF THE WORLD · NO. 1', { family: 'IBM Plex Mono', weight: 500, size: 24, spacing: 7, y: 286, gold: true }),
};
// captions: phrase by phrase, each word lifts as it is spoken
const BIG = new Set(['No bank.', 'No paperwork.', 'Just trust.']);
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
  const cut = M.r0;
  // 1 · 1653
  if (t < cut) {
    T.eyebrow.rise(t, 0.9, 5.6, { dur: 1.1 });
    const y0 = wt('year', '1653') - 0.35;
    T.year.focus(t, y0, null, { dur: 2.0 });
    T.france.rise(t, y0 + 1.0, null, { dur: 1.1, sheen: false });
  }
  // 2 · rewrite
  if (t >= cut) T.rewrote.rise(t, cut + 0.3, M.p0 - 0.45);
  T.payin.rise(t, M.p0 + 0.05, M.k0 - 0.4);
  T.takepot.rise(t, M.k0 + 0.05, M.o0 - 0.4);
  T.round.rise(t, M.o0 + 0.05, M.d0 - 0.55);
  // 6 · Douala
  if (t > M.d0 - 1) {
    scrimMat.uniforms.uTop.value = 0.86 * P(t, M.d0 - 0.4, M.d0 + 0.6) * (1 - P(t, M.c0 - 0.5, M.c0 + 0.3));
    scrimMat.uniforms.uBottom.value = 0.84 * P(t, M.d0 - 0.4, M.d0 + 0.6) * (1 - P(t, M.c0 - 0.5, M.c0 + 0.3));
    scrimMat.uniforms.uAll.value = 0.62 * P(t, M.nob1 - 0.35, M.nob1 + 0.2) * (1 - P(t, M.c0 - 0.6, M.c0 + 0.2));
    T.douala.focus(t, M.d0 + 0.35, M.nob1 - 0.55, { dur: 1.6, scale0: 1.04 });
    T.cfa.rise(t, M.ten - 0.15, M.nob1 - 0.55, { dur: 0.9, sheen: true });
    T.noBank.rise(t, M.nob1 - 0.06, M.nob2 - 0.22, { dur: 0.75, outDur: 0.25 });
    T.noPaper.rise(t, M.nob2 - 0.06, M.just - 0.22, { dur: 0.75, outDur: 0.25 });
    T.trust.rise(t, M.just - 0.06, M.c0 - 0.5, { dur: 0.9 });
  }
  // 7 · the catch, 8 · nobody holds the pot
  T.catchH.rise(t, M.c0 + 0.2, M.n0 - 0.45);
  T.nobody.rise(t, M.nob - 0.12, M.ti0 - 0.55, { dur: 1.15, stagger: 0.075 });
  // 9 · title card
  T.tTitle.focus(t, M.circles - 0.2, null, { dur: 1.8, scale0: 1.05 });
  T.tEp.rise(t, M.circles + 0.5, null, { dur: 1.0 });
  T.tNext.rise(t, M.next - 0.12, null, { dur: 1.0, sheen: false });
  T.tLink.fade(t, M.link - 0.1, null, { dur: 0.7 });
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
const circleKeys = [
  { t: M.r0, tx: 0, ty: 2.2, tz: 0, az: 0, el: 0, dist: 4.7, fov: 30, ap: 0.0 },
  { t: M.bendA, tx: 0, ty: 2.18, tz: 0, az: 0, el: 0.5, dist: 4.9, fov: 30, ap: 0.0 },
  { t: (M.bendA + M.bendB) / 2, tx: 0, ty: 1.85, tz: 0, az: 0, el: 2, dist: 5.6, fov: 30, ap: 0.0 },
  { t: M.bendB, tx: 0, ty: 1.25, tz: 0, az: 0, el: 6, dist: 6.8, fov: 30, ap: 0.004 },
  { t: M.tipB + 0.4, tx: 0, ty: 0.06, tz: 0.18, az: 0, el: 31, dist: 7.3, fov: 30, ap: 0.012 },
  { t: M.k0, tx: 0, ty: 0.06, tz: 0.22, az: 9, el: 35, dist: 7.1, fov: 30, ap: 0.014 },
  { t: M.moveB, tx: 0, ty: 0.08, tz: 0.55, az: 5, el: 27, dist: 5.9, fov: 30, ap: 0.018 },
  { t: M.roundB, tx: 0, ty: 0.05, tz: 0.3, az: 64, el: 50, dist: 7.4, fov: 30, ap: 0.014 },
  { t: M.d0 + 1.2, tx: 0, ty: 0.05, tz: 0.3, az: 74, el: 54, dist: 7.2, fov: 30, ap: 0.014 },
];
const circle2Keys = [
  { t: M.c0 - 1.0, tx: 0.0, ty: 0.08, tz: 0.35, az: -16, el: 30, dist: 7.0, fov: 30, ap: 0.014 },
  { t: M.stretch, tx: 0.0, ty: 0.1, tz: 0.4, az: -14, el: 22, dist: 6.6, fov: 30, ap: 0.016 },
  { t: M.stretch + 2.3, tx: 0.0, ty: 0.12, tz: -0.75, az: -9, el: 12.5, dist: 6.9, fov: 30, ap: 0.014 },
  { t: M.kept + 1.6, tx: 0, ty: 0.05, tz: 0.3, az: -6, el: 36, dist: 7.4, fov: 30, ap: 0.012 },
  { t: M.nob + 1.6, tx: 0, ty: 0.05, tz: 0.42, az: 4, el: 54, dist: 7.9, fov: 30, ap: 0.01 },
  { t: M.ti0 - 0.3, tx: 0, ty: 0.05, tz: 0.45, az: 12, el: 62, dist: 8.0, fov: 30, ap: 0.006 },
  { t: M.ti0 + 2.0, tx: 0, ty: 0, tz: 1.62, az: 22, el: 89.8, dist: 12.4, fov: 30, ap: 0.0 },
  { t: T_END + 0.5, tx: 0, ty: 0, tz: 1.62, az: 38, el: 89.8, dist: 12.8, fov: 30, ap: 0.0 },
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
  for (const c of coins) for (const m of c.mats) m.userData.envMul = 1;
}

// ---- shot 1: the coins, 1653
function shotCoins(t) {
  coinsG.visible = true; circleG.visible = false; clothG.visible = false;
  commonStudio({ envI: 0.32, keyI: 0, rimI: 0.55, bgGlow: lin(0.012, 0.009, 0.006), bgCenter: [0.5, 0.7], bgRadius: 0.55 });
  const tE = wt('year', 'everyone'), tL = wt('year', 'last'), tX = wt('year', 'everything');
  // light fades up with the opening
  spot.intensity = 9 * P(t, 0.2, 3.2, E.inOutSine) * (1 + 0.45 * P(t, tX - 0.2, tX + 1.0, E.inOutSine));
  spot.color.set(0xffdcb0);
  const c0 = COIN_ROW(1.5);
  lightBase.spot.set(c0.x + 1.3, 3.0, c0.z + 2.4);
  spot.target.position.copy(COIN_ROW(2));
  FU.uSpotColor.value.copy(lin(0.03, 0.02, 0.011)).multiplyScalar(P(t, 0.2, 3.2, E.inOutSine));
  FU.uSpot.value.set(c0.x, c0.z, 0, 1.6);
  coins.forEach((c, i) => {
    // "Everyone paid in.": a glint runs down the line
    const glint = pulseWin(t, tE + (NCOIN - 1 - i) * 0.1, 0.18, 0.05, 0.55);
    // "The last one alive took everything.": back to front, all but the first fall
    let fall = 0, dark = 0;
    if (i > 0) {
      const a = tL + (NCOIN - 1 - i) * 0.26;
      const u = clamp((t - a) / 0.55);
      fall = u < 1 ? E.inCubic(u) : 1 + 0.06 * Math.exp(-(t - a - 0.55) * 9) * Math.sin((t - a - 0.55) * 26);
      dark = P(t, a + 0.3, a + 1.3, E.inOutSine);
    }
    c.pivot.rotation.x = -Math.PI / 2 * Math.min(fall, 1.04);
    const survivor = i === 0 ? P(t, tX - 0.2, tX + 0.9, E.outCubic) : 0;
    for (const m of c.mats) { m.userData.envMul = lerp(1, 0.04, dark) * (1 + 0.9 * glint + 0.8 * survivor); m.emissive.copy(GOLD_OLD).multiplyScalar(0.05 * glint + 0.03 * survivor); }
  });
  const q = P(t, 0, M.r0, E.inOutSine);
  const near = COIN_ROW(0).add(V3(0, COIN_R, 0));
  // low along the line, a slow push; focus stays on the first coin (the one that remains)
  const pos = V3(lerp(0.62, 0.5, q), lerp(0.34, 0.29, q), lerp(3.15, 2.55, q));
  const target = V3(lerp(-0.26, -0.08, q), lerp(0.2, 0.185, q), lerp(-1.45, -0.55, q));
  const focusP = near;
  return { cam: { pos, target, up: V3(0, 1, 0), fov: 30, aperture: 0.02, focus: pos.distanceTo(focusP) }, post: { bloom: 0.24, exposure: 1.0 } };
}

// ---- shots 2-5 and 7-9: the circle
const tmpA = V3(0, 0, 0), tmpB = V3(0, 0, 0);
function shotCircle(t, second) {
  coinsG.visible = false; circleG.visible = true; clothG.visible = false;
  // ---------- ellipse state (stretch across oceans, then restore)
  const st = second ? P(t, M.stretch - 0.15, M.stretch + 2.1, E.inOutCubic) : 0;
  const rs = second ? P(t, M.kept - 0.05, M.kept + 1.35, E.outBack) : 0;
  const rz = lerp(lerp(R, 3.1, st), R, rs), rx = lerp(lerp(R, 0.78, st), R, rs);
  const cz = lerp(lerp(0, R - 3.1, st), 0, rs), cx = 0;
  const water = second ? P(t, M.stretch - 0.3, M.stretch + 1.6, E.inOutSine) * (1 - P(t, M.kept, M.kept + 1.4, E.inOutSine)) : 0;
  // ---------- lighting per beat
  const warmth = second ? P(t, M.kept, M.nob + 1.0, E.inOutSine) : 1;
  const cool = second ? (1 - warmth) : 0;
  commonStudio({
    envI: lerp(1.0, 0.7, cool) + 0.15 * (second ? P(t, M.nob, M.nob + 1.5) : 0),
    keyI: lerp(2.1, 1.5, cool), rimI: lerp(0.7, 1.1, cool),
    bgGlow: lin(lerp(0.024, 0.006, cool), lerp(0.017, 0.009, cool), lerp(0.011, 0.016, cool)),
    bgCenter: [0.5, second && t > M.ti0 ? lerp(0.52, 0.66, P(t, M.ti0, M.ti0 + 1.8)) : 0.52],
  });
  key.color.setRGB(1, lerp(0.95, 0.9, cool), lerp(0.88, 1.0, cool));
  lightBase.key.set(2.2, 6, 3.4);
  key.target.position.set(0, 0, 0);
  FU.uWater.value = water; FU.uTime.value = t;
  FU.uBase.value.copy(lin(0.004, 0.004, 0.0048)).lerp(lin(0.003, 0.006, 0.011), water);
  FU.uFog.value = 0.13 * water; FU.uFogColor.value.copy(lin(0.002, 0.003, 0.006));
  scene.fog.color.copy(lin(0.002, 0.003, 0.006)); scene.fog.density = 0.075 * water;
  FU.uSpotColor.value.copy(lin(0.05, 0.036, 0.021)).multiplyScalar(1 - 0.7 * cool); FU.uSpot.value.set(0, cz * 0.5, 0, 1.9 + 0.8 * st);

  // ---------- the ring
  const ringY = 0.023;
  const bulge = second ? pulseWin(t, M.nob + 0.55, 0.25, 0.1, 0.9) : 0;
  const ringR = (s) => 0.023 * (1 + 0.5 * bulge);
  if (!second && t < M.tipB) {
    // the strike-through: a gold wire across "tontine", bending into a circle and lying down
    const draw = P(t, M.strikeA, M.strikeB, E.inOutCubic);
    const b = P(t, M.bendA, M.bendB, E.inOutCubic);
    const tip = P(t, M.tipA, M.tipB, E.inOutCubic);
    const L = lerp(1.18, 2 * Math.PI * R, E.inOutSine(b));
    const k = b / R;
    const lineY = 2.2 - 0.02;
    const cy0 = lineY - R;                         // centre once fully bent
    const centre = V3(0, lerp(cy0, ringY, tip), lerp(0.08, 0, tip));
    const ang = (-Math.PI / 2) * tip;
    const fn = (s, out) => {
      const u = L * (s - 0.5);
      let x, y;
      if (k < 1e-4) { x = u; y = 0; } else { x = Math.sin(k * u) / k; y = -(1 - Math.cos(k * u)) / k; }
      // relative to where the circle's centre will be (top point of the arc sits at the wire's midpoint)
      const ry = y + R, rzz = 0;
      const yy = ry * Math.cos(ang) - rzz * Math.sin(ang), zz = ry * Math.sin(ang) + rzz * Math.cos(ang);
      // before the tip, the whole arc hangs from the wire midpoint at lineY
      const baseY = lerp(lineY - R, centre.y, tip);
      return out.set(x, baseY + yy, centre.z + zz);
    };
    const s0 = 0, s1 = b > 0 ? 1 : draw;
    ring.update(fn, s0, Math.max(s1, 1e-4), ringR, b > 0.999);
  } else {
    ring.update((s, out) => ellipse(Math.PI / 2 + s * 2 * Math.PI, rx, rz, cx, cz, ringY, out), 0, 1, ringR, true);
  }
  ringMat.emissive.copy(GOLD).multiplyScalar(0.15 * bulge);

  // ---------- "tontine" in space
  if (!second && t < M.tipB) {
    worldWord.visible = true;
    const dis = P(t, M.opp + 0.45, M.opp + 1.35, E.inOutSine);
    worldWordMat.uniforms.uOpacity.value = P(t, M.r0, M.r0 + 0.25, E.lin) * (1 - dis);
    worldWordMat.uniforms.uBias.value = dis * 6;
    worldWord.position.set(0, 2.2, 0);
    const s = 1 + 0.04 * P(t, M.r0, M.opp + 1.4, E.lin);
    worldWord.scale.set(WORD.w * s, WORD.h * s, 1);
  } else worldWord.visible = false;

  // ---------- members
  const lit = Array(NM).fill(0), glow = Array(NM).fill(0), scale = Array(NM).fill(1);
  for (let i = 0; i < NM; i++) {
    if (!second) scale[i] = P(t, M.memA + i * 0.075, M.memA + i * 0.075 + 0.7, E.outBack);
    ellipse(theta(i), rx, rz, cx, cz, MR, members3[i]);
  }
  // pay-in: beads arc into the centre and become the pot
  const potC = V3(0, 0.24, 0);
  let potR = 0, potX = potC.clone(), potVis = 0;
  if (!second) {
    let arrived = 0;
    beads.forEach((bd, i) => {
      const a = M.flow + i * 0.075, u = P(t, a, a + 0.85, E.inOutCubic);
      const from = members3[i];
      bd.visible = u > 0 && u < 1 && t < M.k0 + 1;
      bd.position.set(lerp(from.x, potC.x, u), lerp(from.y, potC.y, u) + Math.sin(Math.PI * u) * 0.42, lerp(from.z, potC.z, u));
      arrived += P(t, a + 0.75, a + 0.9, E.outCubic) / NM;
    });
    if (t >= M.flow) { potR = 0.2 * Math.cbrt(arrived); potVis = 1; }
    // one takes the pot: lift, glide to member 0, pour into it
    const lift = P(t, M.liftA, M.liftA + 0.45, E.outCubic);
    const mv = P(t, M.moveA, M.moveB, E.inOutCubic);
    const into = P(t, M.moveB - 0.12, M.moveB + 0.3, E.inOutCubic);
    if (t >= M.liftA) {
      const dest = members3[0];
      potX.set(lerp(potC.x, dest.x, mv), lerp(potC.y + 0.08 * lift, dest.y + 0.02, mv) + Math.sin(Math.PI * mv) * 0.25, lerp(potC.z, dest.z, mv));
      potR = 0.2 * lerp(1, 0.55, mv) * (1 - into);
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
    // the traveling light on the ring
    if (pr > 0 && pr < 1) {
      glowRing.group.visible = true;
      const a = Math.max(0, pr - 0.22), b = pr;
      glowRing.update((s, out) => ellipse(theta(0) + s * 2 * Math.PI, R, R, 0, 0, ringY, out), a, b, (s) => 0.022 * P(s, a, b, E.inOutSine), false);
      glowMat.opacity = 1;
    } else glowRing.group.visible = false;
    const flash = pulseWin(t, M.roundB - 0.1, 0.25, 0.1, 1.0);
    ringMat.emissive.copy(GOLD).multiplyScalar(0.22 * flash);
    for (const s of spokes) s.visible = false;
    for (const c of chords) c.visible = false;
  } else {
    for (const bd of beads) bd.visible = false;
    glowRing.group.visible = false;
    for (const p of pulses) p.visible = false;
    // a fresh round: the pot sits with one member (the holder = member 0, nearest us)
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
    // spokes: every member tied to the holder, thinning as the circle stretches
    const retract = P(t, M.kept - 0.1, M.kept + 0.6, E.inOutCubic);
    for (let i = 0; i < NM; i++) {
      if (i === 0) { spokes[i].visible = false; continue; }
      const d = P(t, M.hold + 0.05 + i * 0.05, M.hold + 0.7 + i * 0.05, E.inOutCubic) * (1 - retract);
      const from = members3[i].clone(), to = hpos.clone();
      const flick = 1 - 0.35 * st * (0.5 + 0.5 * Math.sin(t * 7.3 + i * 1.9));
      placeThread(spokes[i], from, to, d, lerp(0.0045, 0.0022, st), lerp(0.85, 0.38, st) * flick);
    }
    // the pot becomes the ring itself, then every member is tied to every other
    placePulse(pulses[NM], 0, 0, t, M.nob - 0.05, 0.05, 1.0, 0.75, 1.2);
    placePulse(pulses[NM + 1], 0, 0, t, M.nob + 0.55, 0.95, 1.35, 1.2, 0.7);
    const ms = M.nob + 0.5;
    for (let i = 0; i < NM; i++) {
      const j = (i + 3) % NM;
      const d = P(t, ms + i * 0.07, ms + i * 0.07 + 0.95, E.inOutCubic);
      const shimmer = 1 + 0.9 * pulseWin(t, M.rules - 0.05 + i * 0.03, 0.15, 0.05, 0.7);
      placeThread(chords[i], members3[i].clone().setY(MR * 0.55), members3[j].clone().setY(MR * 0.55), d, 0.0036, 0.75 * shimmer);
      lit[i] = P(t, ms + i * 0.07 + 0.25, ms + i * 0.07 + 0.75, E.outCubic);
      glow[i] = pulseWin(t, ms + i * 0.07 + 0.2, 0.15, 0.05, 0.8) * 0.8;
    }
    lit[0] = Math.max(lit[0], 0.0);
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

  // ---------- camera
  const k = track(second ? circle2Keys : circleKeys, t);
  const cam = camFromKey(k);
  // title card: hold the mark still enough to read, tiny drift only
  return { cam, post: { bloom: 0.22 + 0.1 * (second ? P(t, M.nob, M.nob + 1) : P(t, M.roundA, M.roundB)), exposure: lerp(0.95, 0.9, cool) } };
}

// ---- shot 6: Douala, the cloth
function shotCloth(t) {
  coinsG.visible = false; circleG.visible = false; clothG.visible = true;
  commonStudio({ envI: 0.55, keyI: 0, rimI: 0.35 });
  bg.visible = false; floor.visible = false; shadowCatcher.visible = false;
  key.intensity = 4.2; key.color.setRGB(1.0, 0.74, 0.46);
  lightBase.key.set(4.2, 2.3, 0.9); key.target.position.set(0, 1.5, 0);   // low and raking: the folds read
  rim.intensity = 0.5; rim.position.set(-3, 2.5, 1.5); rim.color.setRGB(0.5, 0.6, 1.0);
  envGlobal = 0.4;
  clothTime.value = t;
  const q = P(t, M.d0 - 1.2, M.c0 + 1.2, E.lin);
  // an oblique glide across the drape, focus on the nearest folds
  const target = V3(lerp(-0.55, 0.45, q), lerp(1.72, 1.52, q), 0);
  const pos = V3(lerp(-1.45, -0.55, q), lerp(1.95, 1.7, q), lerp(1.55, 1.62, q));
  return { cam: { pos, target, up: V3(0, 1, 0), fov: 34, aperture: 0.028, focus: pos.distanceTo(target) }, post: { bloom: 0.2, exposure: 1.0 } };
}

// ---- which shots are on screen: a hard cut at 1653 -> Africa, crossfades elsewhere
const XF = 1.0;
function shotsAt(t) {
  if (t < M.r0) return [{ f: shotCoins, w: 1 }];
  const d0 = M.d0, c0 = M.c0;
  if (t < d0 - XF / 2) return [{ f: (tt) => shotCircle(tt, false), w: 1 }];
  if (t < d0 + XF / 2) { const w = E.inOutSine((t - (d0 - XF / 2)) / XF); return [{ f: (tt) => shotCircle(tt, false), w: 1 - w }, { f: shotCloth, w }]; }
  if (t < c0 - XF / 2) return [{ f: shotCloth, w: 1 }];
  if (t < c0 + XF / 2) { const w = E.inOutSine((t - (c0 - XF / 2)) / XF); return [{ f: shotCloth, w: 1 - w }, { f: (tt) => shotCircle(tt, true), w }]; }
  return [{ f: (tt) => shotCircle(tt, true), w: 1 }];
}
function coverShot() {
  const t = M.nob + 2.6;
  const r = shotCircle(t, true);
  const k = { tx: 0, ty: 0.05, tz: -0.05, az: 8, el: 58, dist: 7.1, fov: 30, ap: 0.008 };
  const cam = camFromKey(k);
  // lift the circle into the middle of the frame, between title and tag
  return { cam, post: { bloom: 0.26, exposure: 0.98 } };
}

// the word texture for the 3D "tontine"
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
  finalPass.uniforms.uFade.value = cover ? 1 : P(t, 0.0, 1.4, E.inOutSine);
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

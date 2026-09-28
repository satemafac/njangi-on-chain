import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { MotionValue } from 'framer-motion';
import * as THREE from 'three';
import { getLocale } from '@/lib/i18n';
import { mix, smooth } from './motion';
import { GLOBE_CIRCLES, type GlobeCircle } from './globe-circles';
import { LAND_GRIDS } from './globe-land';
import { decodeLandGrid, unitFromLatLng } from './globe-geo';

/**
 * The hero globe: the world drawn as an ordered grid of dots, with the
 * savings circle's local names pinned where they're native. Hover a region
 * and it warms to gold and names itself (Njangi, Cameroon; Equb, Ethiopia;
 * Tanda, Mexico); click and you're on that tradition's page. Drag to turn it.
 * Left alone, it turns slowly and names each place as it comes round.
 *
 * Staged like an Apple product reveal: at rest the globe sits low, a lit
 * horizon under the headline; as the hero's sticky runway scrolls
 * (`progress` 0 → 1) it rises to centre while the camera eases in.
 *
 * Rendering:
 * - Land is ~8k instanced discs laid flat on the sphere (not screen-facing
 *   points), so they foreshorten toward the limb like print on a globe. The
 *   dot mask is baked offline from Natural Earth (globe-land.ts) — no
 *   polygons ship to the browser. The far side shows through faintly.
 * - No graticule, arcs or particles. Glow is authored (a fresnel limb and an
 *   analytic, dithered halo); nothing is post-processed, so nothing twinkles.
 * - Markers are screen-sized so they read at every zoom; the labels are real
 *   DOM (crisp text, localised country names via Intl.DisplayNames).
 *
 * Harness: boot after first paint with a cancellable shader compile,
 * IntersectionObserver + visibility pause, DPR cap, context-loss recovery,
 * full GPU disposal, and a CSS gradient fallback if WebGL is unavailable.
 * Reduced motion: no spin, no tour, no reveal — it renders on demand, and
 * hover, tap and drag still work.
 */

export interface GlobeStrings {
  /** "Also called {names}" */
  alsoCalled: string;
  /** "Nearby: {names}" — the region's other circles. */
  nearby: string;
  /** The card's link to the tradition's page. */
  readMore: string;
  /** One-line hints, shown once the globe has risen. */
  hintHover: string;
  hintTouch: string;
}

type LabelMode = 'tour' | 'hover' | 'pinned';
type LabelState = { index: number; mode: LabelMode; shown: boolean };

interface SceneHooks {
  progress?: MotionValue<number>;
  label: () => HTMLDivElement | null;
  hint: () => HTMLElement | null;
  /** Show (index ≥ 0) or hide (−1) the label. */
  onLabel: (index: number, mode: LabelMode) => void;
  onOpen: (href: string) => void;
}

const HASH = /* glsl */ `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`;

const LAND_VERTEX = /* glsl */ `
  attribute vec3 aDir;
  uniform float uR;
  uniform float uDot;
  uniform vec3 uHover;
  uniform float uHoverAmt;
  uniform float uHoverInner;
  uniform float uHoverOuter;
  uniform vec3 uRevealFrom;
  uniform float uReveal;
  varying vec2 vUv;
  varying float vFacing;
  varying float vSpot;
  varying float vReveal;
  void main() {
    vec3 n = aDir;
    // A disc lying flat on the sphere: its own east/north tangent frame.
    vec3 up = abs(n.y) > 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
    vec3 east = normalize(cross(up, n));
    vec3 north = cross(n, east);
    float spot = uHoverAmt * smoothstep(uHoverOuter, uHoverInner, dot(n, uHover));
    // The first reveal spreads across the planet from one point, like ink.
    float angle = acos(clamp(dot(n, uRevealFrom), -1.0, 1.0));
    float reveal = 1.0 - smoothstep(uReveal * 3.4 - 0.5, uReveal * 3.4, angle);
    float size = uDot * (1.0 + 0.28 * spot) * mix(0.3, 1.0, reveal);
    vec3 p = n * uR + (east * position.x + north * position.y) * (2.0 * size);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vFacing = dot(normalize(normalMatrix * n), normalize(-mv.xyz));
    vSpot = spot;
    vReveal = reveal;
    vUv = position.xy * 2.0;
    gl_Position = projectionMatrix * mv;
  }`;

const LAND_FRAGMENT = /* glsl */ `
  uniform vec3 uInk;
  uniform vec3 uGold;
  uniform float uBack;
  varying vec2 vUv;
  varying float vFacing;
  varying float vSpot;
  varying float vReveal;
  void main() {
    float r = length(vUv);
    float aa = max(fwidth(r), 1e-4);
    float disc = 1.0 - smoothstep(1.0 - 1.5 * aa, 1.0, r);
    float front = smoothstep(-0.04, 0.16, vFacing);
    // Dim toward the limb, where the dots crowd and foreshorten.
    float limb = mix(0.42, 1.0, smoothstep(0.02, 0.62, vFacing));
    float alpha = mix(uBack, limb, front) * disc * vReveal;
    if (alpha < 0.003) discard;
    // The spotlight warms the land without matching the markers' full gold.
    gl_FragColor = vec4(mix(uInk, uGold, 0.8 * vSpot * front), alpha);
    #include <colorspace_fragment>
  }`;

const MARKER_VERTEX = /* glsl */ `
  attribute vec3 aDir;
  attribute vec3 aState; // x: hovered, y: named by the tour, z: ping phase
  uniform float uR;
  uniform float uPx;
  uniform float uPxToWorld;
  uniform float uAppear;
  varying vec2 vUv;
  varying float vVis;
  varying vec3 vState;
  void main() {
    vec4 mv = modelViewMatrix * vec4(aDir * uR * 1.002, 1.0);
    float facing = dot(normalize(normalMatrix * aDir), normalize(-mv.xyz));
    vVis = smoothstep(0.12, 0.4, facing) * uAppear;
    // Screen-sized: a marker is UI, it reads the same at every zoom.
    float px = uPx * (1.0 + 0.3 * aState.x + 0.12 * aState.y);
    mv.xy += position.xy * px * (-mv.z) * uPxToWorld;
    vUv = position.xy;
    vState = aState;
    gl_Position = projectionMatrix * mv;
  }`;

const MARKER_FRAGMENT = /* glsl */ `
  uniform vec3 uGold;
  uniform vec3 uCore;
  uniform float uTime;
  varying vec2 vUv;
  varying float vVis;
  varying vec3 vState;
  void main() {
    float r = length(vUv);
    float aa = max(fwidth(r), 1e-4);
    float core = 1.0 - smoothstep(0.2 - aa, 0.2 + aa, r);
    float hot = 1.0 - smoothstep(0.0, 0.15, r);
    float ring = (1.0 - smoothstep(0.03 - aa, 0.03 + aa, abs(r - 0.5))) * vState.x;
    float glow = exp(-r * r * 8.0) * (0.3 + 0.3 * vState.x);
    float t = fract(uTime * 0.5 + vState.z);
    float ping = (1.0 - smoothstep(0.022 - aa, 0.022 + aa, abs(r - mix(0.24, 0.94, t)))) * (1.0 - t) * vState.y;
    vec3 color = uGold * (glow + 0.9 * ring + 0.75 * ping) + mix(uGold, uCore, hot) * core;
    gl_FragColor = vec4(color * vVis * (1.0 - smoothstep(0.9, 1.0, r)), 1.0);
    #include <colorspace_fragment>
  }`;

type CompiledProgram = { isReady(): boolean };

/**
 * Compiles the scene's shaders, then calls `done` once the driver reports them
 * linked: `renderer.compileAsync`, but cancellable.
 *
 * three's compileAsync polls each material's program on a 10ms timer that
 * can't be stopped, and reads `properties.get(material).currentProgram
 * .isReady()` unguarded. Dispose the scene while it is still polling and the
 * next tick throws on the torn-down state (Sentry JAVASCRIPT-NEXTJS-9, iOS
 * Safari). The landing does exactly that for a signed-in visitor: it
 * redirects to /dashboard as soon as the session loads, often mid-compile.
 * Returns a cancel function; call it before disposing anything.
 */
function whenCompiled(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  done: () => void
): () => void {
  const pending = renderer.compile(scene, camera);
  // A lost context never reports a program ready; stop waiting and let the
  // context-loss handling take over.
  const giveUpAt = performance.now() + 5000;
  let timer = 0;
  let cancelled = false;
  const check = () => {
    if (cancelled) return;
    pending.forEach((material) => {
      const { currentProgram } = (renderer.properties.get(material) ?? {}) as {
        currentProgram?: CompiledProgram;
      };
      // No program means the context was reset under us: nothing to wait for,
      // the first render compiles it again.
      if (!currentProgram || currentProgram.isReady()) pending.delete(material);
    });
    if (pending.size === 0 || performance.now() > giveUpAt) done();
    else timer = window.setTimeout(check, 10);
  };
  // With KHR_parallel_shader_compile the driver links in the background and
  // can be asked without blocking. Without it compile() has already blocked
  // until linked, and the timer only lets the browser breathe between the
  // compile and the first frame.
  if (renderer.extensions.has('KHR_parallel_shader_compile')) check();
  else timer = window.setTimeout(check, 10);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}

/** Angular radii, as cosines: the hover pick and its hysteresis. */
const PICK_COS = Math.cos((14 * Math.PI) / 180);
const KEEP_COS = Math.cos((18 * Math.PI) / 180);
const TAP_COS = Math.cos((18 * Math.PI) / 180);

/**
 * For each place, the other places within 18° of it, nearest first (at most
 * three): hover West Africa and the card names the region's other circles
 * too. Static, so the card never reshuffles under a moving pointer.
 */
const NEIGHBOURS: number[][] = (() => {
  const dirs = GLOBE_CIRCLES.map((circle) => {
    const v = [0, 0, 0];
    unitFromLatLng(circle.lat, circle.lng, v);
    return v;
  });
  const near = Math.cos((18 * Math.PI) / 180);
  return dirs.map((a, i) =>
    dirs
      .map((b, j) => ({ j, cos: a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }))
      .filter(({ j, cos }) => j !== i && cos > near)
      .sort((x, y) => y.cos - x.cos)
      .slice(0, 3)
      .map(({ j }) => j)
  );
})();

/**
 * Builds the scene into `mount` and starts it; returns the teardown. Split
 * out of the component so the (long, synchronous) setup can be scheduled
 * after the page's first paint rather than inside React's commit.
 */
type SceneHandle = { dispose: () => void; refresh: () => void };

function mountScene(mount: HTMLDivElement, hooks: SceneHooks): SceneHandle | undefined {
  const { progress } = hooks;
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true, // native MSAA — we render straight to the canvas
      alpha: false,
      powerPreference: 'high-performance',
    });
  } catch {
    return undefined; // the CSS gradient behind the canvas stays as the fallback
  }

  let width = mount.clientWidth || window.innerWidth;
  let height = mount.clientHeight || window.innerHeight;
  const dprCap = 2;
  let dpr = Math.min(window.devicePixelRatio || 1, dprCap);

  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height);
  renderer.setClearColor(0x000000, 1);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Fade the canvas in once the first frame exists, instead of popping in
  // whenever the lazy chunk happens to land.
  const canvas = renderer.domElement;
  canvas.style.opacity = '0';
  canvas.style.transition = 'opacity 1.6s cubic-bezier(0.28, 0.11, 0.32, 1)';
  canvas.style.display = 'block';
  // Vertical swipes still scroll the page; horizontal ones turn the globe.
  canvas.style.touchAction = 'pan-y';
  mount.insertBefore(canvas, mount.firstChild);

  const scene = new THREE.Scene();
  const R = 7;

  // A longer lens than a typical WebGL hero: less distortion, reads as a
  // photographed object rather than a fly-through.
  const FOV = 36;
  const camera = new THREE.PerspectiveCamera(FOV, width / height, 0.1, 400);
  const tanHalf = Math.tan(((FOV / 2) * Math.PI) / 180);

  // Poses are framed in SCREEN terms, then solved for the camera, so the
  // shot holds on any aspect ratio (a portrait phone needs the camera much
  // further back than a 16:10 laptop to keep the planet inside the frame).
  //   rest  — the planet's top limb sits at `restTop` of the viewport height,
  //           a lit horizon under the hero copy
  //   risen — centred, and never wider than 90% of the viewport
  let REST_Y = 0;
  let RISEN_Y = 0;
  let CAM_REST_Z = 31;
  let CAM_RISEN_Z = 27.5;
  const frame = () => {
    const aspect = width / Math.max(height, 1);
    // Camera distance at which the planet's diameter spans `share` of the
    // viewport width. Wide screens fall back to the art-directed distances.
    const fitZ = (share: number) => R / (share * tanHalf * Math.min(aspect, 1.6));
    CAM_REST_Z = Math.max(31, fitZ(0.8));
    CAM_RISEN_Z = Math.max(27.5, fitZ(0.9));
    const restTop = aspect < 0.8 ? 0.86 : 0.8;
    const halfH = CAM_REST_Z * tanHalf;
    REST_Y = (0.5 - restTop) * 2 * halfH - R;
    RISEN_Y = aspect < 0.8 ? -0.4 : -0.2;
  };
  frame();
  camera.position.set(0, 0.6, CAM_REST_Z);
  const lookTarget = new THREE.Vector3(0, 0, 0);
  camera.lookAt(lookTarget);

  const GOLD = new THREE.Color('#E8B04B');
  const INK = new THREE.Color('#F2EDE4');
  const CORE = new THREE.Color('#fff6e2');
  // The underside of the limb: a dim warm grey, so gold stays the only accent.
  const SHADE = new THREE.Color('#8f8577');

  // Spin about the polar axis first, then pitch and roll: the rows of dots
  // stay true lines of latitude as the planet turns, with no wobble.
  const globe = new THREE.Group();
  globe.rotation.order = 'ZXY';
  // Pitch eases with the rise: at rest the cap under the headline shows the
  // Sahel and West Africa (where the names live), and as the planet rises it
  // tips its north toward you into the full Africa-and-Europe view.
  const PITCH_REST = -0.3;
  const PITCH_RISEN = 0.22;
  const ROLL = -0.1;
  // Open on Cameroon, where the name njangi comes from. Longitude L faces the
  // camera at spin −(90° + L).
  const START_LNG = 11;
  const START_SPIN = -((90 + START_LNG) * Math.PI) / 180;
  globe.rotation.set(PITCH_REST, START_SPIN, ROLL);
  globe.position.set(0, REST_Y, 0);
  scene.add(globe);

  // --- Lighting: warm key upper-right, cool rim behind-left ---
  scene.add(new THREE.AmbientLight(0xffffff, 0.2));
  const key = new THREE.PointLight(GOLD, 1.8, 140);
  key.position.set(10, 14, 16);
  scene.add(key);
  const rim = new THREE.PointLight(SHADE, 0.35, 140);
  rim.position.set(-12, 4, -10);
  scene.add(rim);

  // --- The planet's body: opaque and dark, so the land reads as print on it ---
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(R * 0.994, 96, 96),
    new THREE.MeshStandardMaterial({ color: 0x0e0d12, roughness: 1, metalness: 0, dithering: true })
  );
  globe.add(body);

  // --- Limb light: a fresnel shell that brightens toward the silhouette ---
  const limb = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.004, 96, 96),
    new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color('#f2c46d') },
        uCool: { value: SHADE.clone().multiplyScalar(0.28) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform vec3 uCool;
        varying vec3 vNormal;
        varying vec3 vView;
        ${HASH}
        void main() {
          float f = pow(1.0 - max(dot(vNormal, vView), 0.0), 6.0);
          // warm on the lit (upper) limb, cooler underneath
          vec3 c = mix(uCool, uColor, smoothstep(-0.6, 0.5, vNormal.y));
          gl_FragColor = vec4(c * f * 0.5, f);
          #include <colorspace_fragment>
          gl_FragColor.rgb += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  globe.add(limb);

  // --- Atmosphere halo ---
  // Computed per pixel on a camera-facing quad: a stretched gradient texture
  // magnifies into visible steps, and a dark gold-on-black falloff bands in
  // 8-bit output, so the falloff is analytic and dithered in the shader.
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(R * 3.6, R * 3.6),
    new THREE.ShaderMaterial({
      uniforms: {
        uInner: { value: R * 0.99 },
        uWidth: { value: R * 0.1 },
        uOuter: { value: R * 1.75 },
        uWarm: { value: new THREE.Color('#f2c46d') },
        uCool: { value: SHADE.clone().multiplyScalar(0.22) },
        uStrength: { value: 0.45 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vPos;
        void main() {
          vPos = position.xy;
          // Billboard: offset the quad in view space around the centre.
          vec4 centre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          gl_Position = projectionMatrix * (centre + vec4(position.xy, 0.0, 0.0));
        }`,
      fragmentShader: /* glsl */ `
        uniform float uInner;
        uniform float uWidth;
        uniform float uOuter;
        uniform vec3 uWarm;
        uniform vec3 uCool;
        uniform float uStrength;
        varying vec2 vPos;
        ${HASH}
        void main() {
          float d = length(vPos);
          if (d < uInner) discard;
          // A tight rim of scattered light, forced to zero well inside the
          // quad so its edges can never show as straight cut lines.
          float glow = exp(-(d - uInner) / uWidth)
            * smoothstep(uInner, uInner + uWidth * 0.35, d)
            * (1.0 - smoothstep(uOuter * 0.72, uOuter, d));
          float top = smoothstep(-0.7, 0.6, vPos.y / d);
          vec3 tint = mix(uCool, uWarm, top);
          gl_FragColor = vec4(tint * glow * uStrength * mix(0.45, 1.0, top), 1.0);
          #include <colorspace_fragment>
          gl_FragColor.rgb += (hash(gl_FragCoord.xy) - 0.5) / 255.0 * step(0.0005, glow);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  globe.add(halo);

  // --- Land: an ordered grid of dots, laid flat on the surface ---
  // Phones get the coarser grid: at their size the fine one's dots shrink
  // to specks and the continents read as grey texture instead of print.
  const grid = Math.min(width, height) < 640 ? LAND_GRIDS.coarse : LAND_GRIDS.fine;
  const landDirs = decodeLandGrid(grid);
  const quad = new THREE.PlaneGeometry(1, 1);
  const landGeo = new THREE.InstancedBufferGeometry();
  landGeo.index = quad.index;
  landGeo.setAttribute('position', quad.getAttribute('position'));
  landGeo.setAttribute('aDir', new THREE.InstancedBufferAttribute(landDirs, 3));
  landGeo.instanceCount = landDirs.length / 3;
  const stepRad = (grid.step * Math.PI) / 180;
  const revealFrom = new THREE.Vector3();
  const landMat = new THREE.ShaderMaterial({
    uniforms: {
      uR: { value: R * 1.001 },
      // Dot diameter ≈ 48% of the grid pitch: distinct dots, legible coasts.
      uDot: { value: R * stepRad * 0.24 },
      uInk: { value: INK },
      uGold: { value: GOLD },
      uBack: { value: 0.075 },
      uHover: { value: new THREE.Vector3(0, 1, 0) },
      uHoverAmt: { value: 0 },
      uHoverInner: { value: Math.cos((2.5 * Math.PI) / 180) },
      uHoverOuter: { value: Math.cos((10 * Math.PI) / 180) },
      uRevealFrom: { value: revealFrom },
      uReveal: { value: prefersReduced ? 1 : 0 },
    },
    vertexShader: LAND_VERTEX,
    fragmentShader: LAND_FRAGMENT,
    transparent: true,
    depthWrite: false,
    // The far side is drawn deliberately (faintly, through the body), so the
    // dots are not depth-tested against it; facing decides their weight.
    depthTest: false,
  });
  const land = new THREE.Mesh(landGeo, landMat);
  land.frustumCulled = false; // the base quad's bounds say nothing about the instances
  land.renderOrder = 1;
  globe.add(land);

  // --- Markers: one per savings circle ---
  type Marker = {
    circle: GlobeCircle;
    dir: THREE.Vector3;
    /** 0 behind the planet → 1 facing the camera, same rule as the shader. */
    vis: number;
    /** Projected position, in CSS pixels within the mount. */
    sx: number;
    sy: number;
    hot: number;
    toured: number;
    lastToured: number;
  };
  const markers: Marker[] = GLOBE_CIRCLES.map((circle) => {
    const v = [0, 0, 0];
    unitFromLatLng(circle.lat, circle.lng, v);
    return {
      circle,
      dir: new THREE.Vector3(v[0], v[1], v[2]),
      vis: 0,
      sx: 0,
      sy: 0,
      hot: 0,
      toured: 0,
      lastToured: -Infinity,
    };
  });
  const cameroon = markers.find((m) => m.circle.id === 'njangi');
  revealFrom.copy(cameroon ? cameroon.dir : markers[0].dir);

  const markerQuad = new THREE.PlaneGeometry(2, 2);
  const markerGeo = new THREE.InstancedBufferGeometry();
  markerGeo.index = markerQuad.index;
  markerGeo.setAttribute('position', markerQuad.getAttribute('position'));
  const markerDirs = new Float32Array(markers.length * 3);
  const markerState = new Float32Array(markers.length * 3);
  markers.forEach((m, i) => {
    markerDirs.set([m.dir.x, m.dir.y, m.dir.z], i * 3);
    markerState[i * 3 + 2] = (i * 0.37) % 1; // stagger the pings
  });
  markerGeo.setAttribute('aDir', new THREE.InstancedBufferAttribute(markerDirs, 3));
  const stateAttr = new THREE.InstancedBufferAttribute(markerState, 3);
  stateAttr.setUsage(THREE.DynamicDrawUsage);
  markerGeo.setAttribute('aState', stateAttr);
  markerGeo.instanceCount = markers.length;
  const markerMat = new THREE.ShaderMaterial({
    uniforms: {
      uR: { value: R },
      uPx: { value: 15 },
      uPxToWorld: { value: tanHalf / (height / 2) },
      uAppear: { value: prefersReduced ? 1 : 0 },
      uGold: { value: GOLD },
      uCore: { value: CORE },
      uTime: { value: 0 },
    },
    vertexShader: MARKER_VERTEX,
    fragmentShader: MARKER_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const markerMesh = new THREE.Mesh(markerGeo, markerMat);
  markerMesh.frustumCulled = false;
  markerMesh.renderOrder = 2;
  globe.add(markerMesh);

  // --- Scroll: the rise ---
  // Fallback scroll source when no progress value is supplied.
  let scrollNorm = 0;
  const onScroll = () => {
    scrollNorm = Math.min(window.scrollY / Math.max(window.innerHeight, 1), 1);
  };
  if (!prefersReduced && !progress) window.addEventListener('scroll', onScroll, { passive: true });
  // Reduced motion has no runway (the hero is one static viewport), and a
  // collapsed scroll range reads back as progress 1 — pin it to the rest pose
  // so the planet stays a horizon under the copy instead of rising behind it.
  const readProgress = () => {
    if (prefersReduced) return 0;
    const p = progress ? progress.get() : scrollNorm;
    return Number.isFinite(p) ? p : 0;
  };

  // Eased copies of the scroll-driven targets, so a flick of the wheel
  // glides instead of teleporting the planet.
  let rise = 0;
  const pose = (dt: number, settle: boolean) => {
    const target = smooth(0, 0.82, readProgress());
    const k = settle ? 1 : 1 - Math.exp(-6 * dt);
    rise += (target - rise) * k;
    globe.position.y = mix(REST_Y, RISEN_Y, rise);
    camera.position.set(0, 0.6, mix(CAM_REST_Z, CAM_RISEN_Z, rise));
    // The camera holds its gaze; the planet moves through the frame. (If
    // the gaze followed the globe it would never read as rising.)
    camera.lookAt(lookTarget);
  };

  // --- Spin: a slow idle turn, plus drag with inertia ---
  const AUTO_SPIN = 0.035; // rad/s, about three minutes a turn
  let spin = START_SPIN;
  let autoSpeed = prefersReduced ? 0 : AUTO_SPIN;
  let spinVelocity = 0; // from a released drag
  let pitchOffset = 0;

  // --- Interaction ---
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const sphere = new THREE.Sphere(new THREE.Vector3(), R);
  const hit = new THREE.Vector3();
  const hoverDir = new THREE.Vector3(0, 1, 0);
  let overGlobe = false; // a mouse is over the planet
  // Where the mouse last was over the canvas. The planet moves under a still
  // cursor (the scroll-driven rise, the page scrolling on), so the pick is
  // re-run every frame from here rather than only on pointermove.
  const mouse = { x: 0, y: 0, inside: false };
  let hovered = -1; // marker under the mouse (or tapped)
  let pinned = false; // a tap opened the card (touch)
  let hoverAmt = 0;
  type Drag = { id: number; x0: number; y0: number; x: number; y: number; t: number; moved: boolean; type: string };
  let drag: Drag | null = null;

  /** Where the pointer meets the planet, in the globe's local frame. */
  const pick = (clientX: number, clientY: number): boolean => {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    sphere.center.copy(globe.position);
    if (!raycaster.ray.intersectSphere(sphere, hit)) return false;
    hoverDir.copy(globe.worldToLocal(hit)).normalize();
    return true;
  };

  /** The visible marker nearest `dir`, within `minCos`. */
  const nearest = (dir: THREE.Vector3, minCos: number, keep = -1) => {
    if (keep >= 0 && markers[keep].vis > 0.35 && dir.dot(markers[keep].dir) > KEEP_COS) return keep;
    let best = -1;
    let bestCos = minCos;
    markers.forEach((m, i) => {
      if (m.vis < 0.35) return;
      const c = dir.dot(m.dir);
      if (c > bestCos) {
        bestCos = c;
        best = i;
      }
    });
    return best;
  };

  let labelIndex = -1;
  let labelMode: LabelMode = 'tour';
  const setLabel = (index: number, mode: LabelMode) => {
    if (index === labelIndex && (index < 0 || mode === labelMode)) return;
    labelIndex = index;
    labelMode = mode;
    hooks.onLabel(index, mode);
  };

  const setCursor = () => {
    canvas.style.cursor = drag?.moved ? 'grabbing' : hovered >= 0 ? 'pointer' : overGlobe ? 'grab' : '';
  };

  let invalidate = () => {}; // assigned below: one render on demand
  let tourTimer = 0;

  const onPointerMove = (e: PointerEvent) => {
    if (drag && e.pointerId === drag.id) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 5) {
        drag.moved = true;
        canvas.setPointerCapture(e.pointerId);
        pinned = false;
        hovered = -1;
        setLabel(-1, 'hover');
      }
      if (drag.moved) {
        // Dragging the width of the planet turns it half a revolution.
        const radius = Math.max(projectedRadius(), 60);
        const perPx = Math.PI / (2 * radius);
        spin += dx * perPx;
        if (drag.type === 'mouse') pitchOffset = THREE.MathUtils.clamp(pitchOffset + dy * perPx * 0.6, -0.35, 0.3);
        const now = performance.now();
        const dt = Math.max((now - drag.t) / 1000, 1 / 240);
        spinVelocity = mix(spinVelocity, (dx * perPx) / dt, 0.35);
        drag.t = now;
        setCursor();
        invalidate();
      }
      drag.x = e.clientX;
      drag.y = e.clientY;
      return;
    }
    if (e.pointerType !== 'mouse') return;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.inside = true;
    hoverFromMouse();
    invalidate();
  };

  const hoverFromMouse = () => {
    overGlobe = mouse.inside && pick(mouse.x, mouse.y);
    if (!pinned) {
      hovered = overGlobe ? nearest(hoverDir, PICK_COS, hovered) : -1;
      if (hovered >= 0) setLabel(hovered, 'hover');
      else if (labelMode !== 'tour') setLabel(-1, 'hover');
    }
    setCursor();
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (!pick(e.clientX, e.clientY)) {
      // A tap off the planet closes a pinned card.
      if (pinned) {
        pinned = false;
        hovered = -1;
        setLabel(-1, 'pinned');
        invalidate();
      }
      return;
    }
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t: performance.now(), moved: false, type: e.pointerType };
    spinVelocity = 0;
  };

  const endDrag = (e: PointerEvent, cancelled: boolean) => {
    if (!drag || e.pointerId !== drag.id) return;
    const wasClick = !drag.moved && !cancelled;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (prefersReduced) spinVelocity = 0;
    drag = null;
    if (wasClick) {
      if (e.pointerType === 'mouse') {
        if (hovered >= 0) hooks.onOpen(markers[hovered].circle.terms[0].href);
      } else {
        const index = pick(e.clientX, e.clientY) ? nearest(hoverDir, TAP_COS) : -1;
        pinned = index >= 0;
        hovered = index;
        setLabel(index, 'pinned');
      }
    }
    setCursor();
    invalidate();
  };
  const onPointerUp = (e: PointerEvent) => endDrag(e, false);
  const onPointerCancel = (e: PointerEvent) => endDrag(e, true);
  const onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || drag) return;
    mouse.inside = false;
    overGlobe = false;
    if (!pinned) {
      hovered = -1;
      if (labelMode === 'hover') setLabel(-1, 'hover');
    }
    setCursor();
    invalidate();
  };
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', onPointerLeave);

  // --- Per-frame bookkeeping ---
  const centre = new THREE.Vector3();
  const world = new THREE.Vector3();
  const outward = new THREE.Vector3();
  const toCam = new THREE.Vector3();
  const ndcPoint = new THREE.Vector3();

  /** The planet's on-screen radius, in CSS pixels. */
  const projectedRadius = () => {
    const d = camera.position.distanceTo(globe.position);
    return (R / (d * tanHalf)) * (height / 2);
  };

  const measureMarkers = () => {
    centre.copy(globe.position);
    for (const m of markers) {
      world.copy(m.dir).multiplyScalar(R).applyMatrix4(globe.matrixWorld);
      outward.copy(world).sub(centre).normalize();
      toCam.copy(camera.position).sub(world).normalize();
      // Same rule as the marker shader, so the label fades with its dot.
      m.vis = smooth(0.12, 0.4, outward.dot(toCam));
      ndcPoint.copy(world).project(camera);
      m.sx = (ndcPoint.x * 0.5 + 0.5) * width;
      m.sy = (-ndcPoint.y * 0.5 + 0.5) * height;
    }
  };

  /**
   * The idle tour names the next place that has turned into view: the one
   * named longest ago, and among equals the one farthest from the last — so
   * the first pass jumps across the planet (Cameroon, then the Cape, then
   * the Nile …) instead of walking West Africa town by town.
   */
  let lastTourDir: THREE.Vector3 | null = null;
  const advanceTour = (now: number) => {
    let best = -1;
    let bestSeen = Infinity;
    let bestNear = Infinity;
    markers.forEach((m, i) => {
      const onScreen = m.sx > width * 0.12 && m.sx < width * 0.88 && m.sy > height * 0.12 && m.sy < height * 0.9;
      if (m.vis < 0.9 || !onScreen || i === labelIndex) return;
      const near = lastTourDir ? m.dir.dot(lastTourDir) : m.circle.id === 'njangi' ? -2 : 0;
      if (m.lastToured < bestSeen || (m.lastToured === bestSeen && near < bestNear)) {
        bestSeen = m.lastToured;
        bestNear = near;
        best = i;
      }
    });
    if (best >= 0) {
      markers[best].lastToured = now;
      lastTourDir = markers[best].dir;
      setLabel(best, 'tour');
    } else if (labelMode === 'tour') {
      setLabel(-1, 'tour');
    }
  };

  const placeLabel = () => {
    const el = hooks.label();
    if (!el || labelIndex < 0) return;
    const m = markers[labelIndex];
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = m.sx - w / 2;
    let y = m.sy - h - 18;
    if (y < 64) y = m.sy + 20; // no room above (the global bar): hang below
    x = Math.min(Math.max(x, 12), width - w - 12);
    el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  };

  let elapsed = 0;
  let revealT = prefersReduced ? 1 : 0;
  let hintShown = false;

  const update = (dt: number, settle: boolean) => {
    elapsed += dt;
    pose(dt, settle);

    // Spin: the idle turn eases out while a hand is on the planet.
    const wantAuto = prefersReduced || overGlobe || pinned || drag ? 0 : AUTO_SPIN;
    autoSpeed += (wantAuto - autoSpeed) * (1 - Math.exp(-2.5 * dt));
    if (!drag) {
      spin += (autoSpeed + spinVelocity) * dt;
      spinVelocity *= Math.exp(-2.2 * dt);
      pitchOffset *= Math.exp(-1.2 * dt);
    }
    globe.rotation.set(mix(PITCH_REST, PITCH_RISEN, rise) + pitchOffset, spin, ROLL);
    globe.updateMatrixWorld(true);
    measureMarkers();
    if (mouse.inside && !drag && !settle) hoverFromMouse();

    // A hovered/pinned place that turns away loses its card.
    if (hovered >= 0 && markers[hovered].vis < 0.3) {
      hovered = -1;
      pinned = false;
      setLabel(-1, labelMode);
      setCursor();
    }

    // Tour: only once the globe has risen into view, and never over a hand.
    const touring = !prefersReduced && rise > 0.35 && hovered < 0 && !pinned && !drag && !overGlobe;
    if (touring) {
      tourTimer += dt;
      if (tourTimer > 3.2 || (labelIndex >= 0 && labelMode === 'tour' && markers[labelIndex].vis < 0.6)) {
        tourTimer = 0;
        advanceTour(elapsed);
      }
    } else {
      tourTimer = 2.2; // the next tour label follows soon after a hand leaves
      if (labelMode === 'tour' && labelIndex >= 0) setLabel(-1, 'tour');
    }

    // Marker states, eased.
    const ease = settle ? 1 : 1 - Math.exp(-9 * dt);
    let dirty = false;
    markers.forEach((m, i) => {
      const hotTarget = i === hovered ? 1 : 0;
      const tourTarget = labelMode === 'tour' && i === labelIndex ? 1 : 0;
      const nh = m.hot + (hotTarget - m.hot) * ease;
      const nt = m.toured + (tourTarget - m.toured) * ease;
      if (Math.abs(nh - m.hot) > 1e-4 || Math.abs(nt - m.toured) > 1e-4) dirty = true;
      m.hot = nh;
      m.toured = nt;
      markerState[i * 3] = nh;
      markerState[i * 3 + 1] = nt;
    });
    if (dirty || settle) stateAttr.needsUpdate = true;

    // The land warms under the pointer (or around a pinned place).
    const spotTarget = overGlobe || hovered >= 0 ? 1 : 0;
    hoverAmt += (spotTarget - hoverAmt) * (settle ? 1 : 1 - Math.exp(-8 * dt));
    if (pinned && hovered >= 0) hoverDir.copy(markers[hovered].dir);
    landMat.uniforms.uHover.value.copy(hoverDir);
    landMat.uniforms.uHoverAmt.value = hoverAmt;

    // First reveal, then the markers.
    if (revealT < 1) revealT = Math.min(1, revealT + dt / 2.2);
    const revealEase = smooth(0, 1, revealT);
    landMat.uniforms.uReveal.value = revealEase;
    markerMat.uniforms.uAppear.value = prefersReduced ? 1 : smooth(0.55, 1, revealT);
    markerMat.uniforms.uTime.value = elapsed;

    placeLabel();

    // The hint appears once the planet has risen, until the first hand on
    // it, and follows the planet: below it when there's room (phones), beside
    // it on wide screens, never over the dots.
    const hint = hooks.hint();
    if (hint) {
      if (overGlobe || drag || pinned) hintShown = true;
      ndcPoint.copy(globe.position).project(camera);
      const cx = (ndcPoint.x * 0.5 + 0.5) * width;
      const cy = (-ndcPoint.y * 0.5 + 0.5) * height;
      const r = projectedRadius();
      let place: 'below' | 'side' | null = null;
      if (cy + r + 64 < height - 16) place = 'below';
      else if (width - (cx + r) > 260) place = 'side';
      if (place === 'below') {
        const w = Math.min(420, width - 40);
        hint.style.width = `${w}px`;
        hint.style.textAlign = 'center';
        hint.style.transform = `translate3d(${Math.round(cx - w / 2)}px, ${Math.round(cy + r + 28)}px, 0)`;
      } else if (place === 'side') {
        hint.style.width = '200px';
        hint.style.textAlign = 'start';
        hint.style.transform = `translate3d(${Math.round(cx + r + 40)}px, ${Math.round(cy + r * 0.45)}px, 0)`;
      }
      hint.style.opacity = !hintShown && place && rise > 0.55 ? '1' : '0';
    }
  };

  const syncViewport = () => {
    markerMat.uniforms.uPxToWorld.value = tanHalf / (height / 2);
  };

  const onResize = () => {
    width = mount.clientWidth || window.innerWidth;
    height = mount.clientHeight || window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    frame();
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height);
    syncViewport();
    invalidate();
  };
  window.addEventListener('resize', onResize);

  let visible = true;
  let running = false;
  let ready = false; // set once shaders are compiled (see begin)
  let raf = 0;
  let last = performance.now();
  let shown = false;

  const reveal = () => {
    if (shown) return;
    shown = true;
    requestAnimationFrame(() => {
      canvas.style.opacity = '1';
    });
  };

  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    // rAF's timestamp is the frame's start and can precede the
    // performance.now() taken in start(), so clamp at 0.
    const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
    last = now;
    update(dt, false);
    renderer.render(scene, camera);
    reveal();
  };
  const start = () => {
    if (!ready || running || prefersReduced || !visible || document.hidden) return;
    running = true;
    last = performance.now(); // drop the paused gap so dt doesn't spike
    raf = requestAnimationFrame(loop);
  };
  const stop = () => {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
  };

  // Reduced motion never runs the loop: it renders when something changes.
  let pendingFrame = 0;
  invalidate = () => {
    if (!prefersReduced || !ready || pendingFrame) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0;
      update(0, true);
      renderer.render(scene, camera);
    });
  };

  const io = new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      if (visible) start();
      else stop();
    },
    { threshold: 0 }
  );
  io.observe(mount);

  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVisibility);

  // A lost context (GPU reset, memory pressure) hands the hero back to the CSS
  // gradient; three rebuilds its state on restore, so resume where we were.
  const onContextLost = (e: Event) => {
    e.preventDefault();
    stop();
    canvas.style.opacity = '0';
  };
  const onContextRestored = () => {
    if (prefersReduced) invalidate();
    else start();
    canvas.style.opacity = '1';
  };
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);

  let tornDown = false;
  const begin = () => {
    if (tornDown) return;
    ready = true;
    if (prefersReduced) {
      update(0, true);
      renderer.render(scene, camera);
      canvas.style.transition = 'none';
      canvas.style.opacity = '1';
    } else {
      pose(0, true);
      start();
    }
  };
  // Compile the scene's shaders off the main thread where the driver allows
  // (KHR_parallel_shader_compile) before the first frame, instead of stalling
  // inside it.
  const cancelCompile = whenCompiled(renderer, scene, camera, begin);

  const dispose = () => {
    tornDown = true;
    cancelCompile();
    stop();
    cancelAnimationFrame(raf);
    cancelAnimationFrame(pendingFrame);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    io.disconnect();
    const disposed = new Set<THREE.Material | THREE.BufferGeometry>();
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry && !disposed.has(mesh.geometry)) {
        mesh.geometry.dispose();
        disposed.add(mesh.geometry);
      }
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
      mats.forEach((m) => {
        if (!disposed.has(m)) {
          m.dispose();
          disposed.add(m);
        }
      });
    });
    quad.dispose();
    markerQuad.dispose();
    renderer.dispose();
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  };

  // The label's size changes when React swaps its text; the running loop
  // re-measures every frame, but reduced motion only renders on demand.
  return { dispose, refresh: () => invalidate() };
}

/** Localised country names ("Cameroun" in French), joined as a list. */
function placeName(circle: GlobeCircle): string {
  const locale = getLocale();
  let names = circle.countries;
  try {
    const display = new Intl.DisplayNames([locale, 'en'], { type: 'region' });
    names = circle.countries.map((code) => display.of(code) ?? code);
  } catch {
    // Older engines: the codes are still better than nothing.
  }
  try {
    return new Intl.ListFormat([locale, 'en'], { style: 'short', type: 'conjunction' }).format(names);
  } catch {
    return names.join(', ');
  }
}

export default function CirclesGlobe({
  progress,
  strings,
}: {
  /** Hero scroll progress (0 at rest, 1 when the sticky stage releases). */
  progress?: MotionValue<number>;
  strings: GlobeStrings;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLParagraphElement>(null);
  const sceneRef = useRef<SceneHandle | undefined>(undefined);
  const [label, setLabel] = useState<LabelState | null>(null);
  const [touchFirst, setTouchFirst] = useState(false);
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    setTouchFirst(window.matchMedia('(hover: none)').matches);
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // Boot after the hero copy has painted: scene setup + first render are one
    // long main-thread task, and first paint shouldn't wait on decoration.
    // Two frames guarantee a paint happened; idle time then does the work
    // (hidden tabs never get either, which is fine — nothing to show there).
    let cancelled = false;
    let raf = 0;
    let idle = 0;
    const boot = () => {
      if (cancelled) return;
      sceneRef.current = mountScene(mount, {
        progress,
        label: () => labelRef.current,
        hint: () => hintRef.current,
        onLabel: (index, mode) =>
          setLabel((prev) => (index < 0 ? (prev ? { ...prev, shown: false } : prev) : { index, mode, shown: true })),
        onOpen: (href) => void routerRef.current.push(href),
      });
    };
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        idle =
          typeof window.requestIdleCallback === 'function'
            ? window.requestIdleCallback(boot, { timeout: 800 })
            : window.setTimeout(boot, 0);
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idle);
      window.clearTimeout(idle);
      sceneRef.current?.dispose();
      sceneRef.current = undefined;
    };
  }, [progress]);

  useEffect(() => {
    sceneRef.current?.refresh();
  }, [label]);

  const circle = label ? GLOBE_CIRCLES[label.index] : null;
  const names = circle ? circle.terms.map((term) => term.name).join(' · ') : '';
  const aka = circle ? circle.terms.flatMap((term) => term.aka) : [];
  const nearby = label
    ? NEIGHBOURS[label.index].flatMap((j) => GLOBE_CIRCLES[j].terms.map((term) => term.name))
    : [];
  const pinned = label?.mode === 'pinned' && label.shown;

  // A tapped card becomes clickable only after a beat. The tap that opened it
  // is followed by the browser's synthetic click at the same spot, and the
  // new card can be under that finger before its first reposition — without
  // this, the opening tap would also follow the card's link.
  const [armed, setArmed] = useState(false);
  const pinnedIndex = pinned ? label.index : -1;
  useEffect(() => {
    setArmed(false);
    if (pinnedIndex < 0) return;
    const timer = window.setTimeout(() => setArmed(true), 450);
    return () => window.clearTimeout(timer);
  }, [pinnedIndex]);

  return (
    <div ref={mountRef} className="absolute inset-0 h-full w-full">
      <div
        ref={labelRef}
        aria-hidden={!pinned}
        className={`absolute left-0 top-0 z-10 transition-opacity duration-300 ease-out will-change-transform ${
          label?.shown ? 'opacity-100' : 'opacity-0'
        } ${pinned && armed ? 'pointer-events-auto' : 'pointer-events-none'}`}
      >
        {circle && label?.mode === 'tour' && (
          <div className="whitespace-nowrap rounded-full bg-black/55 px-3.5 py-2 text-[12px] leading-none shadow-[0_12px_32px_-16px_rgba(0,0,0,0.9)] ring-1 ring-white/[0.12] backdrop-blur-md backdrop-saturate-150">
            <span className="font-semibold tracking-[-0.005em] text-mist">{names}</span>
            <span className="ms-2 text-gold">{placeName(circle)}</span>
          </div>
        )}
        {circle && label?.mode !== 'tour' && (
          <Link
            href={circle.terms[0].href}
            tabIndex={pinned ? 0 : -1}
            className="block w-max max-w-[17rem] rounded-2xl bg-[#111113]/80 px-4 py-3.5 text-start shadow-[0_24px_48px_-24px_rgba(0,0,0,0.95)] ring-1 ring-white/[0.1] backdrop-blur-xl backdrop-saturate-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/80"
          >
            <span className="block text-[19px] font-semibold leading-tight tracking-[-0.012em] text-mist">{names}</span>
            <span className="mt-1 block text-[12px] font-medium tracking-[0.01em] text-gold">{placeName(circle)}</span>
            {aka.length > 0 && (
              <span className="mt-2.5 block text-[12px] leading-snug text-mist-3">
                {strings.alsoCalled.replace('{names}', aka.join(', '))}
              </span>
            )}
            {nearby.length > 0 && (
              <span className="mt-1 block text-[12px] leading-snug text-mist-3">
                {strings.nearby.replace('{names}', nearby.join(', '))}
              </span>
            )}
            <span className="mt-2.5 inline-flex items-center gap-0.5 text-[12px] font-medium text-gold">
              {strings.readMore}
              <span aria-hidden className="rtl:rotate-180">
                ›
              </span>
            </span>
          </Link>
        )}
      </div>
      <p
        ref={hintRef}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 z-10 text-[13px] leading-snug tracking-[-0.01em] text-mist-3 opacity-0 transition-opacity duration-700"
      >
        {touchFirst ? strings.hintTouch : strings.hintHover}
      </p>
    </div>
  );
}

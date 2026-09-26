import { useEffect, useRef } from 'react';
import type { MotionValue } from 'framer-motion';
import * as THREE from 'three';
import { mix, smooth } from './motion';

/**
 * "Diaspora Meridian" — the hero's product shot: a globe drawn in gold light.
 * Continents are dust-constellations (procedural, never a literal map);
 * diaspora hubs are linked by great-circle arcs with contributions streaming
 * along them, and every few seconds the turn hands off to the next hub — the
 * rotating-savings mechanic, played out across the planet.
 *
 * Staged like an Apple product reveal: at rest the globe sits low, a lit
 * horizon under the headline; as the hero's sticky runway scrolls
 * (`progress` 0 → 1) it rises to centre while the camera eases in. Motion is
 * slow and damped — no spin-up, no bounce.
 *
 * Rendering is deliberately calm:
 * - Straight to the canvas with the browser's MSAA. No bloom: its
 *   low-resolution mip chain makes small bright moving points and 1px lines
 *   twinkle ("fireflies"), and its half-float targets cost hundreds of MB at
 *   Retina sizes. Glow is authored instead — a fresnel limb and an analytic,
 *   dithered halo.
 * - Everything drawn on the surface (dust, graticule, arcs, flow) fades by
 *   how squarely it faces the camera, so nothing on the far side can leak
 *   through at the limb or pop in and out of view as the planet turns. Hubs
 *   do the same in JS, and the turn only ever lands on a hub you can see.
 *
 * Harness: frame-rate-independent easing, IntersectionObserver + visibility
 * pause, DPR cap, boot after first paint with async shader compile, reduced
 * motion → one settled frame, full GPU disposal, context-loss recovery, and a
 * CSS gradient fallback if WebGL is unavailable.
 */

/**
 * How visible a point on (or lifted above) the globe should be: it must face
 * the camera AND project inside the planet's silhouette. A facing test alone
 * misses lifted points — an arc can face the camera yet sit past the limb.
 * `p` is relative to the globe's centre; `uR` is the planet's radius.
 */
const SURFACE_VISIBILITY = /* glsl */ `
  uniform float uR;
  float surfaceVisibility(vec3 p, vec4 mv) {
    vec3 n = normalize(normalMatrix * normalize(p));
    float c = dot(n, normalize(-mv.xyz));            // cos of angle to the view
    float projected = length(p) * sqrt(max(1.0 - c * c, 0.0)); // distance from centre on screen
    return smoothstep(0.0, 0.12, c) * (1.0 - smoothstep(uR * 0.84, uR * 0.975, projected));
  }
`;

const HASH = /* glsl */ `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`;

/** Soft round points on the globe's surface, faded toward the limb. */
function surfacePoints(color: THREE.Color, size: number, intensity: number, radius: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uR: { value: radius },
      uColor: { value: color },
      uSize: { value: size },
      uScale: { value: 1 }, // drawing-buffer height / 2, as PointsMaterial does
      uIntensity: { value: intensity },
    },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      uniform float uSize;
      uniform float uScale;
      varying float vAlpha;
      varying float vFace;
      ${SURFACE_VISIBILITY}
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFace = surfaceVisibility(position, mv);
        vAlpha = aAlpha;
        gl_PointSize = uSize * (uScale / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying float vAlpha;
      varying float vFace;
      void main() {
        // Computed disc: a sprite texture magnifies into steps up close.
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float a = (1.0 - smoothstep(0.3, 1.0, r)) * vFace * vAlpha * uIntensity;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor * a, 1.0);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Lines drawn on/above the surface (graticule, arcs), faded toward the limb. */
function surfaceLines(color: THREE.Color, opacity: number, radius: number) {
  return new THREE.ShaderMaterial({
    uniforms: { uR: { value: radius }, uColor: { value: color }, uOpacity: { value: opacity } },
    vertexShader: /* glsl */ `
      varying float vFace;
      ${SURFACE_VISIBILITY}
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFace = surfaceVisibility(position, mv);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vFace;
      void main() {
        float a = uOpacity * vFace;
        if (a < 0.002) discard;
        gl_FragColor = vec4(uColor * a, 1.0);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

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

/**
 * Builds the scene into `mount` and starts it; returns the teardown. Split
 * out of the component so the (long, synchronous) setup can be scheduled
 * after the page's first paint rather than inside React's commit.
 */
function mountScene(mount: HTMLDivElement, progress?: MotionValue<number>): (() => void) | undefined {
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isMobile = window.matchMedia('(max-width: 767px)').matches;

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
  // Full Retina: below 2 the thin graticule and limb are upscaled by the
  // browser and read soft next to crisp system text.
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
  mount.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000000, 0.012);

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
  const TEAL = new THREE.Color('#4DA2FF');
  const HUB_CORE = new THREE.Color('#fff4dc');
  const COWRIE = new THREE.Color('#EDE4D3');

  // Soft round sprite for the hub glows and the free-floating dust.
  const dotCanvas = document.createElement('canvas');
  dotCanvas.width = dotCanvas.height = 128;
  const dctx = dotCanvas.getContext('2d');
  if (dctx) {
    const grd = dctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.3, 'rgba(255,255,255,0.85)');
    grd.addColorStop(0.62, 'rgba(255,255,255,0.18)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    dctx.fillStyle = grd;
    dctx.fillRect(0, 0, 128, 128);
  }
  const dotTex = new THREE.CanvasTexture(dotCanvas);
  dotTex.colorSpace = THREE.SRGBColorSpace;

  const globe = new THREE.Group();
  globe.position.set(0, REST_Y, 0);
  globe.rotation.z = -0.2;
  globe.rotation.x = 0.16;
  scene.add(globe);

  // --- Lighting: warm key upper-right, cool rim behind-left ---
  scene.add(new THREE.AmbientLight(0xffffff, 0.22));
  const key = new THREE.PointLight(GOLD, 2.2, 140);
  key.position.set(10, 14, 16);
  scene.add(key);
  const rim = new THREE.PointLight(TEAL, 0.9, 140);
  rim.position.set(-12, 4, -10);
  scene.add(rim);

  // --- Opaque body so the far side hides and the sphere reads solid ---
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(R * 0.985, 96, 96),
    new THREE.MeshStandardMaterial({ color: 0x0c0b10, roughness: 1, metalness: 0, dithering: true })
  );
  globe.add(body);

  // --- Faint graticule: true latitude/longitude circles ---
  const gratPts: number[] = [];
  const SEG = 160;
  const rG = R * 0.998;
  const ring = (point: (a: number) => [number, number, number]) => {
    for (let s = 0; s < SEG; s++) {
      gratPts.push(...point((s / SEG) * Math.PI * 2), ...point(((s + 1) / SEG) * Math.PI * 2));
    }
  };
  for (let lat = -60; lat <= 60; lat += 30) {
    const phi = (lat * Math.PI) / 180;
    const y = rG * Math.sin(phi);
    const rr = rG * Math.cos(phi);
    ring((a) => [rr * Math.cos(a), y, rr * Math.sin(a)]);
  }
  for (let lon = 0; lon < 180; lon += 30) {
    const th = (lon * Math.PI) / 180;
    ring((a) => [rG * Math.cos(a) * Math.cos(th), rG * Math.sin(a), rG * Math.cos(a) * Math.sin(th)]);
  }
  const gratGeo = new THREE.BufferGeometry();
  gratGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(gratPts), 3));
  globe.add(new THREE.LineSegments(gratGeo, surfaceLines(TEAL, 0.11, R)));

  // --- Limb light: a fresnel shell that brightens toward the silhouette ---
  const limb = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.004, 96, 96),
    new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color('#f2c46d') },
        uCool: { value: TEAL.clone().multiplyScalar(0.8) },
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
          gl_FragColor = vec4(c * f * 0.6, f);
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
        uCool: { value: TEAL.clone().multiplyScalar(0.8) },
        uStrength: { value: 0.55 },
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
          vec3 tint = mix(uCool, uWarm, smoothstep(-0.7, 0.6, vPos.y / d));
          gl_FragColor = vec4(tint * glow * uStrength, 1.0);
          #include <colorspace_fragment>
          gl_FragColor.rgb += (hash(gl_FragCoord.xy) - 0.5) / 255.0 * step(0.0005, glow);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  globe.add(halo);

  // --- Continents: procedural land dust (clustered, NOT a real map) ---
  // Seeded RNG: deterministic across mounts/HMR and between screenshots.
  let rngSeed = 0x6d2b79f5;
  const rand = () => {
    rngSeed = (rngSeed + 0x6d2b79f5) | 0;
    let x = Math.imul(rngSeed ^ (rngSeed >>> 15), 1 | rngSeed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  // A primary blob per continent plus satellite blobs around it gives an
  // irregular coastline; the samples are jittered off the golden-spiral
  // lattice so the dust never reads as a grid.
  const CAND = isMobile ? 9000 : 14000;
  const attractors: THREE.Vector3[] = [];
  const spreads: number[] = [];
  for (let i = 0; i < 6; i++) {
    const core = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
    attractors.push(core);
    spreads.push(0.05 + rand() * 0.05);
    for (let j = 0; j < 3; j++) {
      const off = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.7);
      attractors.push(core.clone().add(off).normalize());
      spreads.push(0.018 + rand() * 0.03);
    }
  }
  const landPos: number[] = [];
  const landAlpha: number[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const dir = new THREE.Vector3();
  for (let i = 0; i < CAND; i++) {
    const y = 1 - (i / (CAND - 1)) * 2;
    const rad = Math.sqrt(1 - y * y);
    const th = golden * i;
    dir
      .set(
        Math.cos(th) * rad + (rand() - 0.5) * 0.02,
        y + (rand() - 0.5) * 0.02,
        Math.sin(th) * rad + (rand() - 0.5) * 0.02
      )
      .normalize();
    let score = 0;
    for (let k = 0; k < attractors.length; k++) {
      score = Math.max(score, Math.exp(-(1 - dir.dot(attractors[k])) / spreads[k]));
    }
    const keep = score > 0.22 ? Math.min(1, score * 1.4) : 0.004;
    if (rand() < keep) {
      landPos.push(dir.x * R, dir.y * R, dir.z * R);
      landAlpha.push(0.55 + rand() * 0.45); // fixed per-grain variation, never animated
    }
  }
  const landGeo = new THREE.BufferGeometry();
  landGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(landPos), 3));
  landGeo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(landAlpha), 1));
  const landMat = surfacePoints(GOLD, 0.13, 1, R);
  globe.add(new THREE.Points(landGeo, landMat));

  // --- Diaspora hubs ---
  const HUBS: [number, number][] = [
    [6.5, 3.4], [18.0, -76.8], [40.7, -74.0], [43.7, -79.4], [51.5, -0.1],
    [48.9, 2.35], [25.2, 55.3], [19.1, 72.9], [14.6, 121.0], [-1.3, 36.8],
    [-26.2, 28.0], [-23.5, -46.6], [19.4, -99.1], [-33.9, 151.2],
  ];
  const latLon = (lat: number, lon: number, r: number) => {
    const phi = ((90 - lat) * Math.PI) / 180;
    const th = ((lon + 180) * Math.PI) / 180;
    return new THREE.Vector3(
      -r * Math.sin(phi) * Math.cos(th),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(th)
    );
  };

  type Hub = {
    dir: THREE.Vector3;
    node: THREE.Mesh;
    glow: THREE.Sprite;
    /** Eased pulse (0 idle → 1 holding the turn) and camera-facing (0 → 1). */
    pulse: number;
    face: number;
  };
  const hubs: Hub[] = [];
  const hubGeo = new THREE.SphereGeometry(0.075, 20, 20);
  for (const [lat, lon] of HUBS) {
    const hubDir = latLon(lat, lon, 1);
    const pos = hubDir.clone().multiplyScalar(R * 1.012);
    const node = new THREE.Mesh(
      hubGeo,
      // Unlit: a hub is a source of light, not a lit bead.
      new THREE.MeshBasicMaterial({ color: HUB_CORE })
    );
    node.position.copy(pos);
    globe.add(node);
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: dotTex,
        color: GOLD,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        // Faded by visibility instead: depth-testing a camera-facing quad
        // against the curved body clipped hard wedges out of the glow.
        depthTest: false,
        blending: THREE.AdditiveBlending,
      })
    );
    glow.position.copy(pos);
    globe.add(glow);
    hubs.push({ dir: hubDir, node, glow, pulse: 0, face: 0 });
  }

  // --- Great-circle arcs (the network rails) ---
  const EDGES: [number, number][] = [
    [0, 4], [0, 2], [0, 9], [0, 1], [4, 5], [4, 2], [4, 6], [4, 7],
    [2, 3], [2, 1], [2, 12], [2, 11], [1, 11], [1, 12], [6, 7], [6, 9],
    [6, 13], [7, 8], [7, 13], [9, 10], [10, 13], [11, 12], [8, 13], [5, 6],
  ];
  const slerp = (a: THREE.Vector3, b: THREE.Vector3, t: number) => {
    const dot = THREE.MathUtils.clamp(a.dot(b), -1, 1);
    const om = Math.acos(dot);
    const so = Math.sin(om);
    if (so < 1e-4) return a.clone();
    return a
      .clone()
      .multiplyScalar(Math.sin((1 - t) * om) / so)
      .add(b.clone().multiplyScalar(Math.sin(t * om) / so));
  };
  type Arc = { a: number; b: number; pts: THREE.Vector3[]; mat: THREE.ShaderMaterial; glow: number };
  const arcs: Arc[] = [];
  const STEPS = 64;
  const ARC_BASE = 0.2;
  for (const [ai, bi] of EDGES) {
    const a = hubs[ai].dir;
    const b = hubs[bi].dir;
    const ang = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
    // Past ~105° an arc wraps the planet and, seen edge-on, loops off the
    // silhouette like an orbit. Keep the network on the surface.
    if (ang > 1.85) continue;
    // Low arcs hug the surface; long hauls lift a little, never into orbit.
    const lift = R * (0.03 + ang * 0.065);
    const pts: THREE.Vector3[] = [];
    for (let s = 0; s <= STEPS; s++) {
      const t = s / STEPS;
      pts.push(slerp(a, b, t).normalize().multiplyScalar(R + Math.sin(Math.PI * t) * lift));
    }
    const mat = surfaceLines(GOLD, ARC_BASE, R);
    globe.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    arcs.push({ a: ai, b: bi, pts, mat, glow: 0 });
  }

  // --- Contributions flowing along the arcs ---
  // Each particle fades in as it leaves a hub and out as it arrives, so a
  // respawn onto a new arc is never a visible pop.
  const FLOW = isMobile ? 150 : 240;
  const flowArc = new Int16Array(FLOW);
  const flowT = new Float32Array(FLOW);
  const flowSpeed = new Float32Array(FLOW);
  const flowPos = new Float32Array(FLOW * 3);
  const flowAlpha = new Float32Array(FLOW);
  for (let i = 0; i < FLOW; i++) {
    flowArc[i] = Math.floor(rand() * arcs.length);
    flowT[i] = rand();
    flowSpeed[i] = 0.05 + rand() * 0.1;
  }
  const flowGeo = new THREE.BufferGeometry();
  flowGeo.setAttribute('position', new THREE.BufferAttribute(flowPos, 3));
  flowGeo.setAttribute('aAlpha', new THREE.BufferAttribute(flowAlpha, 1));
  const flowMat = surfacePoints(TEAL, 0.17, 0.85, R);
  const flow = new THREE.Points(flowGeo, flowMat);
  flow.frustumCulled = false; // positions change every frame; the initial bounds would lie
  globe.add(flow);

  const tmp = new THREE.Vector3();
  const updateFlow = (dt: number) => {
    for (let i = 0; i < FLOW; i++) {
      flowT[i] += flowSpeed[i] * dt;
      if (flowT[i] >= 1) {
        flowT[i] -= 1;
        flowArc[i] = Math.floor(Math.random() * arcs.length);
      }
      const t = Math.min(Math.max(flowT[i], 0), 1);
      const pts = arcs[flowArc[i]].pts;
      const f = t * (pts.length - 1);
      const i0 = Math.floor(f);
      const i1 = Math.min(i0 + 1, pts.length - 1);
      tmp.copy(pts[i0]).lerp(pts[i1], f - i0);
      flowPos[i * 3] = tmp.x;
      flowPos[i * 3 + 1] = tmp.y;
      flowPos[i * 3 + 2] = tmp.z;
      flowAlpha[i] = Math.pow(Math.sin(Math.PI * t), 0.7);
    }
    flowGeo.attributes.position.needsUpdate = true;
    flowGeo.attributes.aAlpha.needsUpdate = true;
  };

  // --- A little cowrie-coloured dust for depth (kept sparse and dim) ---
  const EMB = isMobile ? 50 : 90;
  const embPos = new Float32Array(EMB * 3);
  for (let i = 0; i < EMB; i++) {
    embPos[i * 3] = (rand() - 0.5) * 64;
    embPos[i * 3 + 1] = (rand() - 0.5) * 34;
    embPos[i * 3 + 2] = (rand() - 0.5) * 40 - 6;
  }
  const embGeo = new THREE.BufferGeometry();
  embGeo.setAttribute('position', new THREE.BufferAttribute(embPos, 3));
  const embers = new THREE.Points(
    embGeo,
    new THREE.PointsMaterial({
      color: COWRIE,
      map: dotTex,
      size: 0.14,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  scene.add(embers);

  const syncPointScale = () => {
    const scale = height * dpr * 0.5;
    landMat.uniforms.uScale.value = scale;
    flowMat.uniforms.uScale.value = scale;
  };
  syncPointScale();

  // --- Input: pointer parallax is subtle — the object leads, not the cursor ---
  const mouse = { x: 0, y: 0 };
  const onPointer = (e: PointerEvent) => {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
  };
  // Fallback scroll source when no progress value is supplied.
  let scrollNorm = 0;
  const onScroll = () => {
    scrollNorm = Math.min(window.scrollY / Math.max(window.innerHeight, 1), 1);
  };
  if (!prefersReduced) {
    window.addEventListener('pointermove', onPointer, { passive: true });
    if (!progress) window.addEventListener('scroll', onScroll, { passive: true });
  }
  // Reduced motion has no runway (the hero is one static viewport), and a
  // collapsed scroll range reads back as progress 1 — pin it to the rest pose
  // so the planet stays a horizon under the copy instead of rising behind it.
  const readProgress = () => {
    if (prefersReduced) return 0;
    const p = progress ? progress.get() : scrollNorm;
    return Number.isFinite(p) ? p : 0;
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
    syncPointScale();
  };
  window.addEventListener('resize', onResize);

  let visible = true;
  let running = false;
  let ready = false; // set once shaders are compiled (see begin)
  let raf = 0;
  let last = performance.now();
  let elapsed = 0;
  let active = -1;
  let activeTimer = 0;
  const ACTIVE_INTERVAL = 4.5;
  let shown = false;

  // Eased copies of the scroll-driven targets, so a flick of the wheel
  // glides instead of teleporting the planet.
  let rise = 0;
  let camX = 0;
  let camY = 0.6;

  const pose = (dt: number, settle: boolean) => {
    const p = readProgress();
    const target = smooth(0, 0.82, p);
    const k = settle ? 1 : 1 - Math.exp(-6 * dt);
    rise += (target - rise) * k;
    globe.position.y = mix(REST_Y, RISEN_Y, rise);
    camera.position.z = mix(CAM_REST_Z, CAM_RISEN_Z, rise);
    const ck = settle ? 1 : 1 - Math.exp(-2.2 * dt);
    camX += (mouse.x * 1.1 - camX) * ck;
    camY += (0.6 - mouse.y * 0.55 - camY) * ck;
    camera.position.x = camX;
    camera.position.y = camY;
    // The camera holds its gaze; the planet moves through the frame. (If
    // the gaze followed the globe it would never read as rising.)
    camera.lookAt(lookTarget);
  };

  // How squarely each hub faces the camera (world space; the globe has no
  // parent transform, so its position is its world centre).
  const hubWorld = new THREE.Vector3();
  const outward = new THREE.Vector3();
  const toCam = new THREE.Vector3();
  const measureFacing = () => {
    globe.updateMatrixWorld(true);
    for (const hub of hubs) {
      hub.node.getWorldPosition(hubWorld);
      outward.copy(hubWorld).sub(globe.position);
      const r = outward.length();
      outward.divideScalar(r);
      toCam.copy(camera.position).sub(hubWorld).normalize();
      const c = outward.dot(toCam);
      const projected = r * Math.sqrt(Math.max(1 - c * c, 0));
      // Same rule as SURFACE_VISIBILITY, so hubs and their arcs fade together.
      hub.face = smooth(0, 0.12, c) * (1 - smooth(R * 0.84, R * 0.975, projected));
    }
  };

  /** The turn passes to the next hub (in rotation order) that is in view. */
  const passTurn = () => {
    for (let step = 1; step <= hubs.length; step++) {
      const next = (active + step + hubs.length) % hubs.length;
      if (hubs[next].face > 0.85) {
        active = next;
        return;
      }
    }
  };

  const shadeHubs = (ease: number) => {
    for (let i = 0; i < hubs.length; i++) {
      const hub = hubs[i];
      hub.pulse += ((i === active ? 1 : 0) - hub.pulse) * ease;
      // Behind the limb the hub shrinks away with its glow, rather than
      // flaring through the edge of the planet.
      hub.node.visible = hub.face > 0.01;
      hub.node.scale.setScalar((1 + hub.pulse * 0.5) * hub.face);
      const gmat = hub.glow.material as THREE.SpriteMaterial;
      gmat.opacity = (0.5 + hub.pulse * 0.4) * hub.face;
      hub.glow.visible = gmat.opacity > 0.005;
      hub.glow.scale.setScalar(1.1 + hub.pulse * 1.3);
    }
    for (const arc of arcs) {
      const touches = arc.a === active || arc.b === active ? 1 : 0;
      arc.glow += (touches - arc.glow) * ease;
      arc.mat.uniforms.uOpacity.value = ARC_BASE + arc.glow * 0.28;
    }
  };

  const drawFrame = (dt: number) => {
    elapsed += dt;
    const ease = 1 - Math.exp(-2.5 * dt);
    globe.rotation.y = elapsed * 0.04;
    pose(dt, false);
    measureFacing();

    activeTimer += dt;
    if (active < 0 || activeTimer >= ACTIVE_INTERVAL || hubs[active].face < 0.2) {
      activeTimer = 0;
      passTurn();
    }
    shadeHubs(ease);
    updateFlow(dt);
    embers.rotation.y = elapsed * 0.012;
    renderer.render(scene, camera);
  };

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
    // performance.now() taken in start(), so clamp at 0 — a negative step
    // would run the flow particles backwards off the start of their arc.
    const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
    last = now;
    drawFrame(dt);
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
    if (prefersReduced) {
      renderSettled();
    } else {
      start();
    }
    canvas.style.opacity = '1';
  };
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);

  /** One representative, settled frame: rest pose, turn on the most central hub. */
  const renderSettled = () => {
    globe.rotation.y = 0.6;
    pose(0, true);
    measureFacing();
    passTurn();
    for (const hub of hubs) hub.pulse = hubs.indexOf(hub) === active ? 1 : 0;
    for (const arc of arcs) arc.glow = arc.a === active || arc.b === active ? 1 : 0;
    shadeHubs(0);
    updateFlow(0);
    renderer.render(scene, camera);
  };

  let tornDown = false;
  const begin = () => {
    if (tornDown) return;
    ready = true;
    if (prefersReduced) {
      renderSettled();
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

  return () => {
    tornDown = true;
    cancelCompile();
    stop();
    cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', onPointer);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
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
    dotTex.dispose();
    renderer.dispose();
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  };
}

export default function DiasporaMeridian({
  progress,
}: {
  /** Hero scroll progress (0 at rest, 1 when the sticky stage releases). */
  progress?: MotionValue<number>;
}) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // Boot after the hero copy has painted: scene setup + first render are one
    // long main-thread task, and first paint shouldn't wait on decoration.
    // Two frames guarantee a paint happened; idle time then does the work
    // (hidden tabs never get either, which is fine — nothing to show there).
    let dispose: (() => void) | undefined;
    let cancelled = false;
    let raf = 0;
    let idle = 0;
    const boot = () => {
      if (!cancelled) dispose = mountScene(mount, progress);
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
      dispose?.();
    };
  }, [progress]);

  return <div ref={mountRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />;
}

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/**
 * "Diaspora Meridian" — a genuine 3D globe drawn entirely from gold light:
 * continents as dust-constellations (procedural, never a literal map), diaspora
 * hubs spread across the world linked by gold great-circle arcs, with
 * contribution particles streaming the arcs. Every few seconds one hub becomes
 * the recipient — it flares and its arcs brighten — then the turn hands off
 * around the planet (the rotating-savings mechanic, made global + on-chain).
 *
 * Reuses the hero harness verbatim: perspective camera + depth fog + UnrealBloom,
 * lerped cursor/scroll parallax, IntersectionObserver + visibility pause, DPR cap,
 * reduced-motion → one static frame, full GPU disposal, WebGL fallback.
 */
export default function DiasporaMeridian() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const prefersReduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      return; // leave the CSS gradient fallback behind the canvas
    }

    let width = mount.clientWidth || window.innerWidth;
    let height = mount.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);

    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height);
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0a0a0c, 0.014);

    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    // RTL (ar/fa) right-aligns the hero copy, so mirror the globe to the left.
    const side = document.documentElement.dir === 'rtl' ? -1 : 1;
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 220);
    const baseCam = new THREE.Vector3(0, 3.4, isMobile ? 25 : 26);
    camera.position.copy(baseCam);
    const lookTarget = new THREE.Vector3(isMobile ? 0 : 4.6 * side, -0.3, 0);
    camera.lookAt(lookTarget);

    const GOLD = new THREE.Color('#E8B04B');
    const GOLD_HI = new THREE.Color('#f6d99a');
    const TEAL = new THREE.Color('#4DA2FF');
    const COWRIE = new THREE.Color('#EDE4D3');

    const R = 7;

    // Globe group — shifted right, axially tilted, slow spin (keeps headline clear).
    const globe = new THREE.Group();
    globe.position.set(isMobile ? 0 : 5.5 * side, -0.3, 0);
    globe.rotation.z = -0.18;
    scene.add(globe);

    // --- Lighting (hubs use standard material) ---
    scene.add(new THREE.AmbientLight(0xffffff, 0.28));
    const key = new THREE.PointLight(GOLD, 2.0, 120);
    key.position.set(7, 9, 12);
    scene.add(key);
    // Cool rim so the dark limb/terminator reads (sells the sphere as a solid).
    const rim = new THREE.PointLight(TEAL, 0.7, 120);
    rim.position.set(-9, -3, -7);
    scene.add(rim);

    // --- Opaque occluder so the globe reads SOLID (back-side dust/arcs hide) ---
    const occluder = new THREE.Mesh(
      new THREE.SphereGeometry(R * 0.965, 48, 48),
      // Lit (not MeshBasic) so the globe gets a shading gradient + terminator.
      new THREE.MeshStandardMaterial({ color: 0x12101a, roughness: 1, metalness: 0 })
    );
    globe.add(occluder);

    // --- Inner teal lat/long wireframe for spherical volume ---
    const grid = new THREE.Mesh(
      new THREE.SphereGeometry(R * 0.992, 28, 18),
      new THREE.MeshBasicMaterial({
        color: TEAL,
        wireframe: true,
        transparent: true,
        opacity: 0.13,
      })
    );
    globe.add(grid);

    // --- Continents: procedural land "dust" (clustered, NOT a real map) ---
    // Seeded RNG so the constellation is deterministic across mounts/HMR and
    // matches the OG share render (visual-regression stable).
    let rngSeed = 0x6d2b79f5;
    const rand = () => {
      rngSeed = (rngSeed + 0x6d2b79f5) | 0;
      let x = Math.imul(rngSeed ^ (rngSeed >>> 15), 1 | rngSeed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const CAND = 2800;
    const attractors: THREE.Vector3[] = [];
    const spreads: number[] = [];
    for (let i = 0; i < 7; i++) {
      attractors.push(
        new THREE.Vector3(
          rand() * 2 - 1,
          rand() * 2 - 1,
          rand() * 2 - 1
        ).normalize()
      );
      spreads.push(0.06 + rand() * 0.14);
    }
    const landPos: number[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < CAND; i++) {
      const y = 1 - (i / (CAND - 1)) * 2;
      const rad = Math.sqrt(1 - y * y);
      const th = golden * i;
      const d = new THREE.Vector3(Math.cos(th) * rad, y, Math.sin(th) * rad);
      let score = 0;
      for (let k = 0; k < attractors.length; k++) {
        const dot = d.dot(attractors[k]);
        score = Math.max(score, Math.exp(-(1 - dot) / spreads[k]));
      }
      if (rand() < score * 0.95 + 0.015) {
        landPos.push(d.x * R, d.y * R, d.z * R);
      }
    }
    const landGeo = new THREE.BufferGeometry();
    landGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(landPos), 3)
    );
    const land = new THREE.Points(
      landGeo,
      new THREE.PointsMaterial({
        color: GOLD,
        size: 0.095,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    globe.add(land);

    // --- Diaspora hubs (global spread; abstract dust means exact coords don't matter) ---
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

    type Hub = { dir: THREE.Vector3; node: THREE.Mesh; halo: THREE.Mesh };
    const hubs: Hub[] = [];
    const hubGeo = new THREE.IcosahedronGeometry(0.17, 0);
    const haloGeo = new THREE.SphereGeometry(0.42, 14, 14);
    for (const [lat, lon] of HUBS) {
      const dir = latLon(lat, lon, 1);
      const pos = dir.clone().multiplyScalar(R * 1.01);
      const node = new THREE.Mesh(
        hubGeo,
        new THREE.MeshStandardMaterial({
          color: GOLD_HI,
          emissive: GOLD_HI,
          emissiveIntensity: 1.1,
          roughness: 0.35,
          metalness: 0.3,
        })
      );
      node.position.copy(pos);
      globe.add(node);
      const halo = new THREE.Mesh(
        haloGeo,
        new THREE.MeshBasicMaterial({
          color: GOLD,
          transparent: true,
          opacity: 0.08,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );
      halo.position.copy(pos);
      globe.add(halo);
      hubs.push({ dir, node, halo });
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
    type Arc = {
      a: number;
      b: number;
      pts: THREE.Vector3[];
      line: THREE.Line;
      base: number;
    };
    const arcs: Arc[] = [];
    const STEPS = 44;
    for (const [ai, bi] of EDGES) {
      const a = hubs[ai].dir;
      const b = hubs[bi].dir;
      const ang = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
      const lift = R * (0.1 + ang * 0.22);
      const pts: THREE.Vector3[] = [];
      for (let s = 0; s <= STEPS; s++) {
        const t = s / STEPS;
        const dir = slerp(a, b, t).normalize();
        const alt = R + Math.sin(Math.PI * t) * lift;
        pts.push(dir.multiplyScalar(alt));
      }
      const base = 0.32;
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({
          color: GOLD,
          transparent: true,
          opacity: base,
          depthWrite: false,
        })
      );
      globe.add(line);
      arcs.push({ a: ai, b: bi, pts, line, base });
    }

    // --- Contribution particles flowing along the arcs ---
    const FLOW = 300;
    const flowArc = new Int16Array(FLOW);
    const flowT = new Float32Array(FLOW);
    const flowSpeed = new Float32Array(FLOW);
    const flowPos = new Float32Array(FLOW * 3);
    for (let i = 0; i < FLOW; i++) {
      flowArc[i] = Math.floor(Math.random() * arcs.length);
      flowT[i] = Math.random();
      flowSpeed[i] = 0.05 + Math.random() * 0.12;
    }
    const flowGeo = new THREE.BufferGeometry();
    flowGeo.setAttribute('position', new THREE.BufferAttribute(flowPos, 3));
    const flow = new THREE.Points(
      flowGeo,
      new THREE.PointsMaterial({
        color: TEAL,
        size: 0.16,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    globe.add(flow);

    const tmp = new THREE.Vector3();
    const updateFlow = (dt: number) => {
      for (let i = 0; i < FLOW; i++) {
        flowT[i] += flowSpeed[i] * dt;
        if (flowT[i] >= 1) {
          flowT[i] -= 1;
          flowArc[i] = Math.floor(Math.random() * arcs.length);
        }
        const pts = arcs[flowArc[i]].pts;
        const f = flowT[i] * (pts.length - 1);
        const i0 = Math.floor(f);
        const i1 = Math.min(i0 + 1, pts.length - 1);
        tmp.copy(pts[i0]).lerp(pts[i1], f - i0);
        flowPos[i * 3] = tmp.x;
        flowPos[i * 3 + 1] = tmp.y;
        flowPos[i * 3 + 2] = tmp.z;
      }
      flowGeo.attributes.position.needsUpdate = true;
    };

    // --- Ambient cowrie/gold dust for foreground depth ---
    const EMB = 220;
    const embPos = new Float32Array(EMB * 3);
    for (let i = 0; i < EMB; i++) {
      embPos[i * 3] = (Math.random() - 0.5) * 70;
      embPos[i * 3 + 1] = (Math.random() - 0.5) * 36;
      embPos[i * 3 + 2] = (Math.random() - 0.5) * 60;
    }
    const embGeo = new THREE.BufferGeometry();
    embGeo.setAttribute('position', new THREE.BufferAttribute(embPos, 3));
    const embers = new THREE.Points(
      embGeo,
      new THREE.PointsMaterial({
        color: COWRIE,
        size: 0.07,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    scene.add(embers);

    // --- Post-processing (bloom) ---
    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(dpr);
    composer.setSize(width, height);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      0.52,
      0.45,
      0.4
    );
    composer.addPass(bloom);
    const outputPass = new OutputPass();
    composer.addPass(outputPass);

    // --- Interaction ---
    const mouse = { x: 0, y: 0 };
    let scrollNorm = 0;
    const onPointer = (e: PointerEvent) => {
      mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    const onScroll = () => {
      scrollNorm = Math.min(window.scrollY / Math.max(window.innerHeight, 1), 1);
    };
    if (!prefersReduced) {
      window.addEventListener('pointermove', onPointer, { passive: true });
      window.addEventListener('scroll', onScroll, { passive: true });
    }

    const onResize = () => {
      width = mount.clientWidth || window.innerWidth;
      height = mount.clientHeight || window.innerHeight;
      const nextDpr = Math.min(window.devicePixelRatio || 1, 1.75);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(nextDpr);
      renderer.setSize(width, height);
      composer.setPixelRatio(nextDpr);
      composer.setSize(width, height);
    };
    window.addEventListener('resize', onResize);

    let visible = true;
    let running = false;

    const clock = new THREE.Clock();
    let raf = 0;
    let active = 0;
    let activeTimer = 0;
    const ACTIVE_INTERVAL = 5.5;

    const drawFrame = (dt: number) => {
      const t = clock.elapsedTime;
      // Frame-rate-independent smoothing — consistent feel on 60Hz and 120Hz.
      const ease = 1 - Math.exp(-5 * dt);
      const camEase = 1 - Math.exp(-3 * dt);
      globe.rotation.y = t * 0.045;

      // advance the "turn"
      activeTimer += dt;
      if (activeTimer >= ACTIVE_INTERVAL) {
        activeTimer = 0;
        active = (active + 1) % hubs.length;
      }

      for (let i = 0; i < hubs.length; i++) {
        const isActive = i === active;
        const mat = hubs[i].node.material as THREE.MeshStandardMaterial;
        const target = isActive ? 3.2 : 1.0;
        mat.emissiveIntensity += (target - mat.emissiveIntensity) * ease;
        const s = isActive ? 1.6 + Math.sin(t * 4) * 0.12 : 1.0;
        hubs[i].node.scale.setScalar(
          hubs[i].node.scale.x + (s - hubs[i].node.scale.x) * ease
        );
        const hmat = hubs[i].halo.material as THREE.MeshBasicMaterial;
        const ho = isActive ? 0.28 : 0.08;
        hmat.opacity += (ho - hmat.opacity) * ease;
        const hs = isActive ? 1.5 : 1.0;
        hubs[i].halo.scale.setScalar(
          hubs[i].halo.scale.x + (hs - hubs[i].halo.scale.x) * ease
        );
      }

      for (let i = 0; i < arcs.length; i++) {
        const touches = arcs[i].a === active || arcs[i].b === active;
        const mat = arcs[i].line.material as THREE.LineBasicMaterial;
        const to = touches ? 0.75 : arcs[i].base;
        mat.opacity += (to - mat.opacity) * ease;
      }

      updateFlow(dt);
      embers.rotation.y = t * 0.02;

      const tx = baseCam.x + mouse.x * 2.2;
      const ty = baseCam.y - mouse.y * 1.3 + scrollNorm * 3;
      const tz = baseCam.z - scrollNorm * 4.5;
      camera.position.x += (tx - camera.position.x) * camEase;
      camera.position.y += (ty - camera.position.y) * camEase;
      camera.position.z += (tz - camera.position.z) * camEase;
      camera.lookAt(lookTarget);

      composer.render();
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      drawFrame(Math.min(clock.getDelta(), 0.05));
    };
    const start = () => {
      if (running || prefersReduced || !visible || document.hidden) return;
      running = true;
      clock.getDelta(); // drop the paused gap so dt doesn't spike on resume
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

    // Context-loss insurance: stop rendering into a dead context; the CSS
    // gradient fallback behind the canvas stays visible.
    const onContextLost = (e: Event) => {
      e.preventDefault();
      stop();
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost, false);

    if (prefersReduced) {
      updateFlow(0);
      // settle a representative static frame
      for (let i = 0; i < hubs.length; i++) {
        const mat = hubs[i].node.material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = i === 0 ? 3.0 : 1.0;
      }
      composer.render();
    } else {
      start();
    }

    return () => {
      stop();
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
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
      bloom.dispose();
      outputPass.dispose();
      composer.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div
      ref={mountRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}

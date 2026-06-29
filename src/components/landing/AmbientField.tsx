import { useEffect, useRef } from 'react';
import * as THREE from 'three';

/**
 * Site-wide ambient depth layer: a sparse cloud of gold dust drifting in a 3D
 * volume behind all content, parallaxing to scroll + cursor. Low density, no
 * bloom, low alpha → atmosphere that keeps body sections from reading as
 * flat-black void, without hurting legibility. Mounted once, fixed, behind
 * everything (inline zIndex so it can't be tree-shaken by a missing utility).
 */
export default function AmbientField() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const prefersReduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;

    // Skip the second WebGL context on small screens — the hero scene is enough
    // there, and two contexts on mid-range mobile blows the frame budget.
    if (window.matchMedia('(max-width: 767px)').matches) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    } catch {
      return;
    }

    const w = () => window.innerWidth;
    const h = () => window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w(), h());
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, w() / h(), 0.1, 120);
    camera.position.set(0, 0, 26);

    const COUNT = 1400;
    const pos = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 80;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 70;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 50;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: new THREE.Color('#E8B04B'),
        size: 0.12,
        transparent: true,
        opacity: 0.32,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    scene.add(points);

    const mouse = { x: 0, y: 0 };
    let scrollNorm = 0;
    const onPointer = (e: PointerEvent) => {
      mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    const onScroll = () => {
      const max = Math.max(
        document.body.scrollHeight - window.innerHeight,
        1
      );
      scrollNorm = Math.min(window.scrollY / max, 1);
    };
    const onResize = () => {
      camera.aspect = w() / h();
      camera.updateProjectionMatrix();
      renderer.setSize(w(), h());
    };
    if (!prefersReduced) {
      window.addEventListener('pointermove', onPointer, { passive: true });
      window.addEventListener('scroll', onScroll, { passive: true });
    }
    window.addEventListener('resize', onResize);

    const clock = new THREE.Clock();
    let raf = 0;
    let running = false;

    // Run only in the first ~1.3 viewports (the dust is imperceptible behind
    // dense content past the hero) and only while the tab is visible — and
    // actually STOP the loop when out of range rather than spinning empty.
    const inRange = () =>
      !document.hidden &&
      window.scrollY > window.innerHeight * 0.12 && // hero owns the first viewport
      window.scrollY <= window.innerHeight * 1.3;

    const draw = () => {
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      const camEase = 1 - Math.exp(-2.5 * dt); // frame-rate independent
      points.rotation.y = t * 0.012;
      const tx = mouse.x * 3;
      const ty = -scrollNorm * 22 - mouse.y * 2;
      camera.position.x += (tx - camera.position.x) * camEase;
      camera.position.y += (ty - camera.position.y) * camEase;
      camera.lookAt(0, camera.position.y * 0.4, 0);
      renderer.render(scene, camera);
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      draw();
    };
    const start = () => {
      if (running || prefersReduced || !inRange()) return;
      running = true;
      clock.getDelta();
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (!running) return;
      running = false;
      cancelAnimationFrame(raf);
    };
    const onState = () => (inRange() ? start() : stop());
    document.addEventListener('visibilitychange', onState);
    window.addEventListener('scroll', onState, { passive: true });

    // Context-loss insurance (matches the hero) — stop rendering into a dead
    // context if the GPU drops it (more likely with two contexts held).
    const onContextLost = (e: Event) => {
      e.preventDefault();
      stop();
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost, false);

    if (prefersReduced) {
      draw();
    } else {
      start();
    }

    return () => {
      stop();
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onState);
      document.removeEventListener('visibilitychange', onState);
      window.removeEventListener('resize', onResize);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      geo.dispose();
      (points.material as THREE.Material).dispose();
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
      className="pointer-events-none fixed inset-0"
      style={{ zIndex: 0 }}
    />
  );
}

# Calibration: numbers that worked, mistakes already made

Read before changing light, bloom, materials or type colour. Every item
below cost a render pass in Ep. 1.

## Exposure, bloom, type

- The scene renders linear HDR; the final pass applies ACES with
  `c *= exposure / 0.6`. Anything much above ~2.5 linear goes white.
- **First pass looked like neon.** Softbox panels at 5-7.5 made gold
  highlights blow out to white, and bloom (threshold 0.9, strength 0.5)
  haloed everything, type included. Fix: bloom threshold **1.3**, strength
  **0.22-0.35**, radius 0.45; exposure ~0.95-1.0.
- **Type must stay under the bloom threshold** or it gets a fuzzy halo:
  ivory ≈ `lin(0.88, 0.85, 0.79)`, gold gradient top ≈ 0.95, the sheen adds
  at most ~0.55. Only the passing sheen may glint.
- Glowing lines read as cheap sci-fi. Threads are **physical gold wires**
  (`goldMat` on thin cylinders, small emissive), not additive neon.
  Additive colours that survived: pulses `lin(0.7,0.46,0.17)`, travelling
  glow `lin(1.5,0.98,0.38)`; member glow emissive ≤ 0.32, orb ≤ 0.13.

## Gold needs big, soft light, not hot light

- **Second pass looked black.** Dividing the softboxes by 5 fixed the white
  but a thin gold tube in a dark room reflects mostly darkness. What worked:
  large sources at modest intensity, plus a **warm horizon band** (a
  cylinder around the scene, `lin(0.16,0.12,0.085)`) so gold never reflects
  pure black from any angle. Current panels: overhead 18×10 @ ~1.0, strips
  3×14 @ ~1.3 warm / ~0.8 cool, back kicker @ ~0.5, front fill @ ~0.6.
- A warm stage pool on the floor under the hero (`uSpotColor ≈
  lin(0.05,0.036,0.021)`, radius ~1.9) grounds the object and shows shadows.
- **Standing coin faces rendered as dark discs**: a metal face pointed at
  the lens reflects what is behind the camera. Fix: a dedicated env
  (`ENV_COINS`) with a large warm panel behind the lens, assigned to those
  materials only.
- Relief normal maps: the beaded rim sparkled like LEDs at normal strength
  6 / spot 26. Strength 4, normalScale 0.75, roughness 0.34, spot ~9.

## three.js traps (r186)

- If a material has no `envMap` and `scene.environment` is set, three
  **overwrites `envMapIntensity` with `scene.environmentIntensity`**, so
  per-material reflection control silently does nothing. Assign `envMap`
  explicitly (the `env()` helper does).
- `PCFSoftShadowMap` was removed (falls back to PCF with a warning); soft
  shadows come from jittering the light per sub-frame instead.
- `Reflector` clones the camera for its mirror pass: the background quad
  hides itself from any camera other than the main one
  (`onBeforeRender` + `uniformsNeedUpdate`), otherwise it floods the
  reflection.
- Reflection blur = mip bias on the mirror render target
  (`generateMipmaps = true`, `LinearMipmapLinearFilter`); bias ~3.3 for a
  polished-but-soft studio floor, reflection strength ~0.42.
- GLSL `smoothstep(e0, e1, x)` with `e0 > e1` is undefined behaviour; write
  `1.0 - smoothstep(e1, e0, x)`.
- Build text only after `document.fonts.load(...)` resolves, or every word
  is measured and rasterised in a fallback font.
- Headless Chrome needs `--use-gl=angle --use-angle=metal
  --ignore-gpu-blocklist` to get the Apple GPU (check the WebGL renderer
  string says "ANGLE Metal Renderer: Apple …"); `--disable-gpu` falls back
  to software and is ~20× slower.

## Composition (portrait 1080×1920)

- A row of standing objects seen along its length collapses into a "roll".
  Put the camera low and to the side so the line recedes diagonally, and
  turn each object to face the lens (`rotation.order = 'YXZ'` so tipping over
  happens about the object's own axis).
- Frame the hero between the headline band (~280-560 px) and the caption
  band (~1400-1510 px). Two failures in Ep. 1: a member sitting under the
  caption line, and a two-line headline wrapping into three at 100 px
  (use 92 px and `maxWidth` ~1000 for two-line headlines).
- A long stretch reads as distance only at a low camera (el ~12°) looking
  down the long axis, with light fog; high angles make it a flat diagonal.
- Cloth folds only read with raking light (low key from the side) and
  enough folds across the frame (fold frequency ~7.6 per unit at ~1.7 m).
- Mechanic scenes at ~7 units, el 30-50°, FOV 30: the ring fills ~90 % of
  the width without distortion. Title card: straight down, ~12.5 units, the
  mark shifted into the upper third by moving the target +z.

## Ep. 2 additions

- Portrait frames are only ~17° wide at FOV 30. A long route has to recede
  in DEPTH (far end near the horizon, near end low in frame) and stay
  within about +-8.6° sideways, or its ends fall out of frame.
- Coin stack: camera ~15° above, ~2.5 units away, target just above the
  stack so it sits between the title band and the captions.
- Louvre light = a SpotLight with a slatted `map` (needs `castShadow`). Keep
  it as its own light at intensity 0 elsewhere: toggling a map or shadow on
  a shared light changes shader defines and recompiles mid-render.
- Wood read as orange at `#5a3419`; `#3f2616` to `#2e1b0f` reads as varnished
  hardwood under warm light.

## Render budget

M1 Pro, 1080×1920, 16 samples: ~4.7 frames/s → a 78 s film in ~8.5 min.
Probe sets (~27 stills) take under a minute. CRF 15 master ≈ 290 MB (the
grain is expensive); CRF 16 upload ≈ 215 MB; CRF 20 review ≈ 40 MB at
43 dB PSNR vs the master.

## Reel 008 additions (Move. Transact. Save.)

- **Orbits push the subject sideways.** A camera key whose target sits at
  a fixed +z offset centres the circle at azimuth 0. At 40-70 degrees the
  same offset turns sideways and pushes the circle off the frame edge. Put
  the offset along the key's own azimuth instead:
  `tx = d*sin(az), tz = d*cos(az)` (`kk()` in `film-008.js`).
- **Black glass reflects only what is in its mirror direction.**
  - A phone screen at el 35-42 degrees sees the dark band of the studio
    environment, so it reads as a void.
  - A punctual spot light makes a point highlight on it that blooms into a
    flare.
  - What worked: no spot, a key light from behind and high (its reflection
    never reaches the lens), and the phone's own PMREM with a 2 x 12 strip
    light raised ~37 degrees behind it, plus a dim spill panel.
  - Sweep the strip across the glass with `material.envMapRotation`
    (-0.3 to 0.6 rad over ~4 s). A 5-unit panel filled the whole glass
    (a grey slab); 1.3 units crossed it in 0.4 s (missed by the probes).
- **A phone pointed at the lens** (long axis toward the camera): at about
  4.3 units it fills ~57% of the frame width. At 3 units it overflows.
  Aim ~0.35 behind it so it sits under the hook type.
- **Routes over water.**
  - Lifts of 0.4-0.6 near the camera read as hoops; 0.15-0.22 skims the
    water like a flight path.
  - Keep far ends within +-1.1 at z -10.
  - A small additive glowing tip at the drawing end sells "money moving".
- **An empty stretch of picture under an introduction** (6 s of water while
  the voice names the speaker) needs a documentary name card: the name in
  Instrument Serif and the role in mono gold.
- **Floor rings that mark beats** (one per name): use a thin ring (0.985-1.0)
  at ~0.45 opacity. The standard pulse ring reads as a second circle.

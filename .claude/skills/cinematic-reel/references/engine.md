# The film engine (`marketing/assets/circles/film.js`)

A single ES module, served over a local HTTP server by `render-webgl.js`
(ES modules cannot load from `file://`). It is sectioned with banners:

| Banner | Keep or edit for a new episode |
|---|---|
| `ENGINE` | keep: helpers, renderer, light rig, materials, floor, `TextBlock`, camera, accumulation, post |
| `SERIES` | keep: the circle motif (ring tube, 8 members, pot orb, beads, threads, pulses) |
| `EPISODE` | rewrite: timeline marks, scene sets (coins, cloth), words on screen, shots, cover |

For episode N, copy `film.js` and `film.html` to `film-epNN.js/.html`, point
the html at the new js, and set `film_page` in the spec. Do not fork the
engine sections casually: fixes there should flow back to `film.js`.

## Contract with the renderer

- `window.__ready = true` once fonts, textures and shaders are ready;
  `window.__failed` holds the error text if boot fails (the driver exits).
- `window.__frame(t, samples)` renders time `t` (seconds) and resolves to a
  `data:` URL of raw RGBA (bottom-up rows). `t < 0` renders the cover.
- The page is a pure function of `t`: no clocks, no randomness at render
  time (textures use a fixed-seed generator at boot).

## Time: word-timed beats

`TL` is the timeline JSON (`?tl=` query). `wt(visual, word, n)` returns
when the n-th occurrence of `word` is spoken in that scene; everything is
keyed to these, so the film re-times itself when the voice changes. The `M`
object gathers the marks (`M.opp` = "opposite", `M.nob` = "nobody", …) and
derived windows (`M.bendA/B`, `M.tipA/B`, `M.moveA/B`, `M.roundA/B`).

Motion helpers: `P(t, a, b, ease)` = eased 0→1 progress over `[a, b]`;
`pulseWin(t, a, rise, hold, fall)` = a bump. Eases: `outExpo` (type
reveals), `inOutCubic` (object moves), `inOutSine` (fades, camera),
`outBack` (things arriving with a little overshoot), `inCubic` (falling).

## Shots

`shotsAt(t)` returns which shots are on screen with weights: a hard cut is a
weight step, a dissolve is `E.inOutSine` over `XF` seconds (1.0). Each shot
function `(t) -> { cam, post }` sets object visibility and state for that
instant, lights, background, floor and fog, and returns:

- `cam`: `{ pos, target, up, fov, aperture, focus }`. Circle shots use keyed
  tracks: `{ t, tx, ty, tz, az, el, dist, fov, ap }` interpolated by `track()`
  (Hermite with Catmull-Rom tangents: continuous velocity, no stops) and
  turned into a camera by `camFromKey()` (handles straight-down views).
- `post`: `{ bloom, exposure }`.

During a dissolve both shots render every sub-frame and are blended in the
accumulation buffer, so the crossfade is a true double exposure.

## Sub-frame accumulation (the "expensive" look)

`renderFrame(t, N)` renders N sub-frames (default 16) into a float buffer:
each one jitters time across a 180° shutter (motion blur), the lens across
an aperture disk with an off-axis frustum that keeps the focal plane fixed
(depth of field), the key/spot lights across a disk (soft shadows), and the
sub-pixel offset (anti-aliasing). Type is rendered inside each sub-frame, so
it gets motion blur too. Then bloom → ACES → vignette, grain, chromatic
aberration → sRGB, once per frame. More samples = smoother bokeh and blur:
16 for everything, 32 for the cover.

## Materials and light

- `ENV`: a PMREM baked from a dark room with big soft panels and a warm
  horizon band (`studioEnvironment()`); `ENV_COINS` adds a large source
  behind the lens for standing coin faces. Every PBR material gets its env
  map explicitly through `env(mat, base)` so per-object reflection can be
  driven (`mat.userData.envMul`); see calibration.md for why.
- `goldMat(roughness)`, `obsidianMat()`; members lerp obsidian → gold with
  `setMemberLook(member, lit, glow)`.
- Floor: `Reflector` with a custom shader (mip-biased blurred reflection,
  Fresnel, warm stage pool `uSpot*`, water mode `uWater`, fog `uFog`) plus a
  `ShadowMaterial` catcher plane.
- Lights: `key` (directional, shadows), `rim`, `spot` (shadows); base
  positions in `lightBase`, jittered per sub-frame.

## The circle motif (SERIES)

- `ring`: a dynamic `Tube` (`update(fn, s0, s1, radius, closed)`); any
  parametric curve, drawn on from `s0` to `s1`. In Ep. 1 it starts as the
  strike-through line and bends into the circle (constant-curvature arc whose
  curvature ramps to `1/R`, then tips flat onto the floor).
- `members[i]` at `theta(i)` on an ellipse (`rx, rz, cx, cz`) so the circle
  can stretch; member 0 is nearest the camera.
- `orb` (the pot), `beads` (contributions), `spokes` and `chords` (gold
  wires), `pulses` (floor rings), `glowRing` (the travelling turn).

## Type (`TextBlock`)

`new TextBlock(text, { family, weight, style, size, spacing, lineHeight, y,
maxWidth, color, gold })` rasterises each word to its own texture (fonts
must be loaded first; they are, at the top of the module). `*word*` = gold
metallic gradient with a light sheen; `\n` = line break; long lines wrap
into two balanced lines.

- `.rise(t, tin, tout, opts)`: words slide up out of a per-line mask,
  staggered (the Apple reveal). Use for statements.
- `.focus(t, tin, tout, opts)`: defocus → focus with a slow scale settle.
  Use for big numerals and names (1653, "Douala, Cameroon.").
- `.fade(t, tin, tout)`: for small labels.

Captions are built from the timeline's phrases (`chunks`) and lift word by
word as spoken; phrases listed in `BIG` are shown as large statements
instead (Ep. 1: "No bank. / No paperwork. / Just trust.").

Type fonts: Inter Tight (statements, captions), Instrument Serif (heritage
names, years, series title), IBM Plex Mono (labels). All vendored from npm
(`@fontsource/*`) so renders are identical offline.

## Adding a shot for a new tradition

1. Build the set once at boot (geometry, materials via `env()`), add it to
   a `THREE.Group`, hide it by default.
2. Write `shotX(t)`: set group visibility, call `commonStudio({...})` for
   light/background defaults, override what the beat needs, compute the
   camera, return `{ cam, post }`.
3. Add it to `shotsAt()` with a dissolve (or a hard cut only if the message
   needs one).
4. Add its words to `T` and drive them in `drawOverlay()`.
5. Probe it (`--probe auto`) before rendering anything long.

Never generate people or hands; tell the story with objects, textiles,
light and type.

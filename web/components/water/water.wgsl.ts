/**
 * The water, as a fragment shader.
 *
 * Inline rather than a `.wgsl` file on purpose. `effect()` takes WGSL as a
 * string, so a template literal costs nothing, while a `.wgsl` import would need
 * a loader rule configured twice — `turbopack.rules` for `npm run dev` and the
 * `webpack()` hook for `next build`, which this app already uses for something
 * else. One shader is not worth a second build-config surface, and the loader
 * validates nothing anyway: invalid WGSL ships with exit code 0 either way.
 *
 * The palette is still the stylesheet's: --paper, the three water stops and
 * --shaft-rgb arrive as uniforms and are mixed at the same gradient positions, so
 * this and the CSS fallback are the same colours at the same depths.
 *
 * The *composition* is no longer the stylesheet's, and that is the point. Two
 * earlier versions of this file translated `.shafts` literally — four bars at
 * fixed screen positions, rotated by a static angle — and then animated the
 * angle. Both read as four rectangles being animated, because that is what they
 * were: there was no water in the picture, only shapes on timers. CSS cannot draw
 * a water surface at any effort, so translating what CSS *can* draw guarantees the
 * shader has nothing to add.
 *
 * So the model here is a surface, not a set of shapes. One wave field — three
 * sines over the horizontal — defines a rippled ceiling, and everything else is
 * derived from it: the shafts hang from it and lean with its slope, they brighten
 * under its crests, the caustics crawl with its phase, and the whole background
 * refracts through it. Nothing has a timer of its own except the wave field, which
 * is why it holds together as one surface rather than several animations that
 * happen to share a screen.
 *
 * The ceiling is not drawn, though. It used to be — a lit band with a bright rim
 * along the waterline, sitting in the top few percent of the viewport — and drawn
 * is exactly where it went wrong: a bright wavy line across the top of a page reads
 * as a decoration stuck to the header, not as the far side of the water you are
 * looking up through. So the surface is kept above the viewport and only its
 * consequences are on screen. The viewer is well under it, which is the point.
 *
 * Colours arrive as sRGB 0..1 straight from the stylesheet's custom properties
 * and are mixed as-is, with no linearisation. That is not sloppiness — CSS
 * gradients interpolate in sRGB too, so doing the same is what keeps the palette
 * matching instead of the shader coming out subtly darker in the mid-tones.
 */
export const WATER_WGSL = /* wgsl */ `
struct P {
  paper    : vec4f,  // --paper, opaque; the shader owns the background outright
  water1   : vec4f,  // --water-1 / --sunlit
  water2   : vec4f,  // --water-2 / --twilight
  water3   : vec4f,  // --water-3 / --midnight
  shaftCol : vec4f,  // rgb = --shaft-rgb, a = --shaft-alpha
  texel    : vec2f,  // 1 / surface size, in pixels
  time     : f32,    // seconds, from the frame clock
  tint     : f32,    // --depth-tint * (1 - (--t * 0.62 + --lev * 0.38))
  shaft    : f32,    // --shaft * 0.5
  motion   : f32,    // 0 under prefers-reduced-motion, else 1
  aspect   : f32,    // width / height, so rotations are not skewed by uv
}

@group(0) @binding(0) var<uniform> p: P;

// Resting depth of the surface, in uv. Negative: the surface sits above the top
// edge of the viewport, out of frame. Every shaft still starts on it and every
// caustic is still cast by it, so the wave field does all the work it did before —
// it just is not something you can look at. At +0.055 it was, and a rippled line
// across the top of the page is furniture.
//
// Far enough up that the whole field clears the frame: the three amplitudes below
// sum to 0.038, so the surface lives between -0.178 and -0.102.
const SURFACE: f32 = -0.14;

// ---------------------------------------------------------------------------
// The wave field. Everything visible below is read off these three lines.
// ---------------------------------------------------------------------------

// Depth of the surface above a given column, in uv-y. x arrives multiplied by
// aspect so a wavelength stays a wavelength when the window is resized instead of
// stretching with it.
//
// Three sines at unrelated rates and no shared factor between the frequencies: two
// would beat visibly and give the whole surface a period, which is the tell that
// turns water back into an animation.
fn surfaceY(x: f32) -> f32 {
  let t = p.time * p.motion;
  var h = 0.0;
  h += 0.020 * sin(x * 2.30 + t * 0.62);
  h += 0.012 * sin(x * 4.10 - t * 0.87);
  h += 0.006 * sin(x * 7.90 + t * 1.31);
  return SURFACE - h;
}

// Slope of the surface, by central difference rather than by differentiating the
// three sines by hand — the derivative stays correct when the amplitudes above are
// retuned, which they will be.
fn surfaceSlope(x: f32) -> f32 {
  let d = 0.02;
  return (surfaceY(x + d) - surfaceY(x - d)) / (2.0 * d);
}

// Curvature, second difference. Sign convention: surfaceY measures *downward*, so
// a crest bulges toward the viewer and comes out positive here.
fn surfaceCurve(x: f32) -> f32 {
  let d = 0.03;
  return (surfaceY(x + d) - 2.0 * surfaceY(x) + surfaceY(x - d)) / (d * d);
}

// ---------------------------------------------------------------------------

// The gradient's own stops: --water-1 at 0%, -2 at 26%, -3 at 52%, and alpha
// falling to nothing by 80%. CSS interpolates \`transparent\` premultiplied, so
// the tail loses opacity without dragging the hue toward black — hence a
// separate alpha ramp rather than a mix to vec4f(0).
fn tintAt(y: f32) -> vec4f {
  var rgb: vec3f;
  if (y < 0.26) {
    rgb = mix(p.water1.rgb, p.water2.rgb, y / 0.26);
  } else if (y < 0.52) {
    rgb = mix(p.water2.rgb, p.water3.rgb, (y - 0.26) / 0.26);
  } else {
    rgb = p.water3.rgb;
  }
  let a = 1.0 - smoothstep(0.52, 0.80, y);
  return vec4f(rgb, a);
}

// One shaft, as a cone hanging off the surface rather than a bar placed on the
// screen. cx is where its mouth meets the surface, in uv-x.
fn shaftAt(uv: vec2f, x: f32, cx: f32, lean: f32, wide: f32, seed: f32) -> f32 {
  let mouth = cx * p.aspect;
  let originY = surfaceY(mouth);

  // Aim. The static lean plus the surface's own tilt where the shaft leaves it —
  // light bends where the surface is tilted, so this is both the physical reason
  // and the reason the four shafts never move as a block: each one is reading the
  // slope at a different place on the same wave.
  let angle = lean + p.motion * surfaceSlope(mouth) * 0.9;
  let c = cos(-angle);
  let s = sin(-angle);

  let q = vec2f(x - mouth, uv.y - originY);
  let local = vec2f(q.x * c + q.y * s, -q.x * s + q.y * c);
  // Above the surface there is no shaft, only surface.
  if (local.y <= 0.0) { return 0.0; }

  // A shaft spreads as it sinks, but not without limit: these run the height of
  // the viewport now, and at the old rate of spread the four wide ones met and
  // flooded the whole lower half into one pale sheet.
  let halfW = 0.5 * 0.12 * p.aspect * wide * (1.0 + local.y * 1.15);
  // Softness grows with depth too. Roughly \`filter: blur(7px)\` at the mouth, in
  // texels so it holds its apparent width across dpr, and a gradient with no edge
  // left by the bottom. A constant blur is most of why an earlier version read as
  // four rectangles: real shafts have an edge only where they start.
  let soft = max(9.0 * p.texel.y, 0.006) + local.y * 0.14;
  let across = smoothstep(halfW + soft, halfW - soft, abs(local.x));

  // Crests focus light and troughs spread it, so a shaft is brightest when the
  // water above its mouth is bunched up. This is the flicker, and it is the wave
  // field's, not a timer's.
  let focus = clamp(0.62 + surfaceCurve(mouth) * 0.55, 0.22, 1.30);

  // Length. These reach the bottom of the viewport. An earlier cut faded them out
  // by 58% of the height, which — together with caustics weighted to nothing by
  // 80% — put every moving thing in the top strip and left the rest of the page a
  // still gradient. Light does get absorbed on the way down, but it gets absorbed
  // gradually, so the falloff is long rather than absent.
  //
  // 1.3 rather than 1.05 because the mouth moved off screen: local.y is already
  // ~0.14 at the top edge, so a falloff measured from the surface now runs out just
  // before the bottom of the page.
  let down = 1.0 - smoothstep(0.0, 1.3, local.y);

  // No mouth fade. There used to be one — the shafts opened out of the surface
  // rather than switching on at full width — but the surface is above the frame
  // now, so that fade happens entirely off screen and every visible pixel is past
  // it.

  // Light quivering along the beam. The one term here still driven by the clock
  // rather than the surface, kept because the axis it travels along is the one the
  // eye is already following, and kept small for the same reason.
  let quiver = 1.0 + p.motion * 0.18 * sin(local.y * 7.0 - p.time * 1.05 + seed);

  return across * down * focus * quiver;
}

// Crossing wave trains, sharpened: the bright web on a pool floor is caustics,
// light focused by a rippled surface. The one thing here with no CSS equivalent at
// any effort, since it has to move to read as water at all.
//
// The scale matters more than the amplitude did. Earlier versions sampled at 5-6
// cycles across the viewport, which is not a web, it is two or three soft blobs —
// so no amount of turning the brightness up made it read as caustics. Twelve is
// close to what a metre of water actually projects on a pool floor at this
// apparent distance.
fn caustics(x: f32, y: f32) -> f32 {
  let t = p.time * p.motion;
  // Warped by the surface overhead, so the web crawls with the waves that are
  // supposedly casting it instead of sliding along on its own schedule.
  let q = vec2f(x, y) * 12.0 + vec2f(surfaceY(x) * 26.0, surfaceSlope(x) * 1.2);
  var v = sin(q.x * 1.15 + t * 0.90) * sin(q.y * 1.45 - t * 0.70);
  v += 0.75 * sin(q.x * 2.10 - t * 0.62) * sin(q.y * 0.85 + t * 0.83);
  v += 0.50 * sin((q.x + q.y) * 1.70 + t * 0.50);
  let n = clamp(v * 0.30 + 0.5, 0.0, 1.0);
  return pow(n, 2.6);
}

// Suspended motes: silt, plankton, whatever is in the water. Cheap, and the
// cheapest cue there is that the viewer is *in* the water rather than looking at a
// picture of it — a still image of open water is ambiguous, a still image of open
// water with something floating in it is not.
fn hash21(v: vec2f) -> f32 {
  return fract(sin(dot(v, vec2f(41.3, 289.1))) * 43758.5453);
}

fn moteLayer(x: f32, y: f32, scale: f32, rise: f32, seed: f32) -> f32 {
  let t = p.time * p.motion;
  // Cells drift down the field so the motes appear to rise through it.
  let g = vec2f(x, y + t * rise) * scale;
  let cell = floor(g);
  let r = hash21(cell + seed);
  // Sparse: most cells are empty, or this is a texture rather than a few specks.
  if (r > 0.07) { return 0.0; }

  let at = vec2f(
    0.5 + 0.34 * sin(r * 91.0 + t * 0.5),
    0.5 + 0.34 * cos(r * 57.0 + t * 0.4),
  );
  return smoothstep(0.10, 0.0, length(g - cell - at));
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Aspect-corrected horizontal, used everywhere below: it is what makes a wave
  // and a shaft keep their shape instead of shearing with the window.
  let x = uv.x * p.aspect;
  let t = p.time * p.motion;

  // Refraction. Looking up through a moving surface bends everything behind it,
  // which is what makes the whole body of water feel like one volume rather than a
  // gradient with effects drawn on top. Strongest near the surface and never zero:
  // the caustics below are warped by this too, and they now run to the bottom of
  // the viewport.
  let deep = max(1.0 - smoothstep(0.0, 0.9, uv.y), 0.30);
  let wob = p.motion * deep * vec2f(
    0.014 * sin(uv.y * 7.5 + t * 0.66),
    0.009 * sin(x * 4.40 - t * 0.92),
  );

  // Tint over paper, exactly as the stylesheet has it: the paper stays the
  // background at every depth and the water is a wash on top of it, which is
  // what stops deep pages turning into grey soup.
  let wash = tintAt(clamp(uv.y + wob.y, 0.0, 1.0));
  var col = mix(p.paper.rgb, wash.rgb, wash.a * clamp(p.tint, 0.0, 1.0));

  // Everything additive from here is screen-blended at the end, matching
  // \`mix-blend-mode: screen\` on .shafts. In a shader it is one line.
  var lit = 0.0;

  // The surface is not drawn. Three terms used to live here — the lit far side of
  // it, a bright rim piled along the waterline where it goes mirror at a glancing
  // angle, and the glow hanging under it — and together they were a wavy bright
  // line across the top eighth of every page. Physically right, and wrong for this:
  // a line at the top of a scrolling page attaches itself to the header and reads
  // as a graphic, whichever way it ripples. Being under water does not mean seeing
  // the ceiling. What follows is what the ceiling does, which is the part that
  // carries it.

  // Shafts hanging off that surface. The four wide ones are still the stylesheet's
  // four spans, at its positions and leans; what has changed is that the surface
  // decides where each one starts, which way it points and how bright it is.
  //
  // The three thin ones in between are not in the stylesheet and are here for one
  // reason: with only four, the *unlit* water between them falls into a regular
  // rhythm and starts reading as dark wedges. Breaking the spacing with narrower,
  // dimmer rays is what stops the gaps from looking like geometry.
  lit += shaftAt(uv, x, 0.12, 0.1222, 0.70, 0.0) * 0.85;
  lit += shaftAt(uv, x, 0.24, 0.0524, 0.28, 5.2) * 0.45;
  lit += shaftAt(uv, x, 0.35, -0.0873, 1.15, 1.7) * 0.85;
  lit += shaftAt(uv, x, 0.50, 0.1920, 0.34, 8.9) * 0.45;
  lit += shaftAt(uv, x, 0.63, 0.1571, 0.55, 3.1) * 0.85;
  lit += shaftAt(uv, x, 0.74, -0.2094, 0.30, 11.4) * 0.45;
  lit += shaftAt(uv, x, 0.85, -0.1396, 0.90, 4.6) * 0.85;

  // Caustics. Strongest just under the surface, and thinned rather than switched
  // off with depth: the floor keeps a faint web crawling across the bottom of the
  // viewport, which is the difference between being under water and looking at a
  // lit strip above a flat background.
  //
  // The depth weight has a floor too. It was \`clamp(tint * 3.0)\`, which on a nearly
  // graduated launch multiplied an already faint web by a small number and left
  // nothing: a shallow page should thin the water, not switch the light off.
  let near = max(1.0 - smoothstep(0.02, 0.85, uv.y), 0.24);
  let depth = clamp(p.tint * 5.0, 0.30, 1.0);
  lit += caustics(x + wob.x, uv.y + wob.y) * near * 0.60 * depth;

  // The deep water's own undulation: broad, slow bands of light sinking through
  // the volume, phase-locked to the surface overhead so they arrive as that
  // surface's light rather than as a second effect. Weighted the other way from
  // everything above — nothing at the top, all of it at the bottom — because this
  // exists to give the depth something to do.
  let far = smoothstep(0.25, 0.95, uv.y);
  let sink = 0.5 + 0.5 * sin(uv.y * 5.4 - t * 0.55 + surfaceY(x) * 34.0);
  lit += sink * far * 0.16 * depth;

  // Motes. Three layers at different sizes and rise rates, so they part into
  // foreground and distance instead of one flat field of dots.
  var mote = 0.0;
  mote += moteLayer(x, uv.y, 26.0, -0.013, 0.0) * 0.55;
  mote += moteLayer(x, uv.y, 44.0, -0.021, 7.3) * 0.35;
  mote += moteLayer(x, uv.y, 68.0, -0.031, 19.1) * 0.22;
  lit += mote * (0.35 + 0.65 * deep);

  lit = min(lit, 1.5) * p.shaftCol.a * clamp(p.shaft, 0.0, 1.0);
  let L = clamp(lit, 0.0, 1.0);

  // Screen-blended, matching \`mix-blend-mode: screen\` on .shafts. In a shader it
  // is one line.
  let glow = 1.0 - (1.0 - col) * (1.0 - p.shaftCol.rgb * L);

  // And the same field spent the other way round, because screen has no headroom
  // on a pale paper. Measured: on the light block's #f4efe2 the whole thing above
  // moves the mean pixel by half a level and a surface is simply not visible. So
  // where the paper is light, the light field darkens the water it is *not* in
  // instead of brightening the water it is — which is what a pool actually looks
  // like from below on a bright day. Faded out by the gradient's own alpha so the
  // bottom of a long page is clean paper either way.
  let shade = col * (1.0 - 0.13 * wash.a * clamp(p.tint * 2.5, 0.0, 1.0) * (1.0 - L));

  // Not a theme flag: the two blocks of globals.css are only the two we ship, and
  // a --paper somebody sets to mid-grey should get some of each.
  let paperLum = dot(p.paper.rgb, vec3f(0.2126, 0.7152, 0.0722));
  col = mix(glow, shade, smoothstep(0.35, 0.75, paperLum));

  // Dither, ±half a level. Everything above lives in the bottom twentieth of the
  // range on a dark paper — the mean luminance of a frame is about 10 of 255 — and
  // an 8-bit target quantises gradients that shallow into visible horizontal
  // terraces. A hash per pixel per frame breaks the terraces up, and because it
  // moves it averages out in the eye rather than reading as noise.
  col += (hash21(uv * vec2f(1913.0, 1361.0) + t) - 0.5) / 255.0;

  return vec4f(col, 1.0);
}
`;

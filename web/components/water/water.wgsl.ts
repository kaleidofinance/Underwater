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
 * Everything here is a translation of the `.water` / `.shafts` rules in
 * globals.css, which remain the fallback and the reference. Read them together —
 * the numbers are deliberately the same numbers, so a visitor without WebGPU
 * gets the same picture standing still, and the shader's job is only to make it
 * move: the shafts sway, and there are caustics the CSS cannot draw at all.
 *
 * Colours arrive as sRGB 0..1 straight from the stylesheet's custom properties
 * and are mixed as-is, with no linearisation. That is not sloppiness — CSS
 * gradients interpolate in sRGB too, so doing the same is what keeps the two
 * implementations matching instead of the shader coming out subtly darker in the
 * mid-tones.
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

// One shaft, in its own frame. CSS gives each span \`transform-origin: top
// center\` and then rotates and scales it, so the sample point is carried into
// that frame rather than the bar being built in screen space.
fn shaftAt(uv: vec2f, cx: f32, rot: f32, scaleX: f32, seed: f32) -> f32 {
  // The sway. A CSS \`transform\` is one static angle; here the angle is the
  // static one plus a slow wander, which is most of why this file exists.
  let angle = rot + p.motion * 0.045 * sin(p.time * 0.13 + seed);
  let c = cos(-angle);
  let s = sin(-angle);

  // Pivot: top centre, where \`top: -14vh\` puts it. x is multiplied by aspect so
  // a rotation stays a rotation — in raw uv it would shear with the window.
  let q = vec2f((uv.x - cx) * p.aspect, uv.y + 0.14);
  let local = vec2f(q.x * c + q.y * s, -q.x * s + q.y * c);

  // width: 12vw, height: 96vh.
  let halfW = 0.5 * 0.12 * p.aspect * scaleX;
  // \`filter: blur(7px)\` — as an edge softness in the same units, so it holds
  // its apparent width across dpr and window size instead of being a constant.
  let edge = max(7.0 * p.texel.y, 0.004);

  let across = smoothstep(halfW + edge, halfW - edge, abs(local.x));
  // Alpha runs from --shaft-alpha at the top to zero at 72% of the height, which
  // is why the shafts are gone well before the fold.
  let down = 1.0 - clamp(local.y / (0.96 * 0.72), 0.0, 1.0);
  let ends = smoothstep(-0.02, 0.06, local.y);

  // Water is not a lamp: each shaft breathes on its own phase.
  let breathe = 1.0 - p.motion * 0.18 * (0.5 - 0.5 * sin(p.time * 0.21 + seed * 2.3));

  return across * down * ends * breathe;
}

// Crossing wave trains, sharpened. The bright web on a pool floor is caustics —
// light focused by a rippled surface — and it is the one thing here with no CSS
// equivalent at any effort, since it has to move to read as water at all.
fn caustics(uv: vec2f) -> f32 {
  let q = vec2f(uv.x * p.aspect, uv.y) * 6.0;
  let t = p.time * p.motion;
  var v = sin(q.x * 1.15 + t * 0.65) * sin(q.y * 1.45 - t * 0.48);
  v += 0.6 * sin(q.x * 2.1 - t * 0.42) * sin(q.y * 0.85 + t * 0.57);
  let n = clamp(v * 0.31 + 0.5, 0.0, 1.0);
  return pow(n, 4.0);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // The surface swell, as a shift in where the gradient is read from. Cheaper
  // than displacing anything and it reads as the whole body of water rising.
  let swell = p.motion * 0.006 * sin(uv.x * p.aspect * 2.3 + p.time * 0.28);
  let y = clamp(uv.y + swell, 0.0, 1.0);

  // Tint over paper, exactly as the stylesheet has it: the paper stays the
  // background at every depth and the water is a wash on top of it, which is
  // what stops deep pages turning into grey soup.
  let wash = tintAt(y);
  var col = mix(p.paper.rgb, wash.rgb, wash.a * clamp(p.tint, 0.0, 1.0));

  // Both of the additive layers are screen-blended, matching
  // \`mix-blend-mode: screen\` on .shafts. In a shader it is one line.
  var lit = 0.0;
  lit += shaftAt(uv, 0.12, 0.1222, 0.70, 0.0);   //  6% + half of 12vw,  7deg
  lit += shaftAt(uv, 0.35, -0.0873, 1.15, 1.7);  // 29%,                -5deg
  lit += shaftAt(uv, 0.63, 0.1571, 0.55, 3.1);   // 57%,                 9deg
  lit += shaftAt(uv, 0.85, -0.1396, 0.90, 4.6);  // 79%,                -8deg
  lit = min(lit, 1.4) * p.shaftCol.a * clamp(p.shaft, 0.0, 1.0);

  // Caustics live where the light does — near the surface, gone by mid-page —
  // and thin out with the tint, so a page deep into its curve gets less of
  // everything rather than a bright web over black.
  let near = 1.0 - smoothstep(0.0, 0.46, uv.y);
  lit += caustics(uv) * near * 0.09 * clamp(p.shaft, 0.0, 1.0) * clamp(p.tint * 3.0, 0.0, 1.0);

  col = 1.0 - (1.0 - col) * (1.0 - p.shaftCol.rgb * clamp(lit, 0.0, 1.0));

  return vec4f(col, 1.0);
}
`;

#!/usr/bin/env node
/**
 * Renders brand/curve-anim.html to video.
 *
 *   node brand/animate.mjs
 *
 * There is no ffmpeg on this machine and no plan to require one, so the encoder
 * is the browser: `MediaRecorder` in headless Chrome, plus sharp for the
 * still-image animation formats (GIF, animated WebP) from the same frames.
 *
 * That buys a WebM and not an MP4. `isTypeSupported` is a claim about the
 * container, not the codec: asked for `video/mp4;codecs=avc1` this Chrome records
 * zero bytes, and asked for plain `video/mp4` it returns a well-formed MP4 with a
 * VP9 track inside — which X rejects at upload. Since X will not take WebM
 * either, **the GIF is the postable asset** and the WebM is a bonus. See MIMES
 * below for how the candidates are judged.
 *
 * Two stages, deliberately separate:
 *
 *   1. CAPTURE — call `frame(t)` on the page, screenshot, repeat. The page holds
 *      no clock (see its header comment), so the frames are evenly spaced in *t*
 *      regardless of how long each screenshot took. Recording the page as it
 *      plays would instead sample whatever the compositor managed under load,
 *      and a stutter would be baked into the file.
 *
 *   2. ENCODE — paint the captured frames into a canvas in a second page and
 *      record that. Here real time *is* the frame clock (MediaRecorder stamps
 *      `requestFrame()` by wall clock), which is why this stage sleeps 1/fps
 *      between frames and takes as long as the video is.
 *
 * Frames move between Node and the page over a scratch HTTP server rather than
 * `Runtime.evaluate` string literals: ~150 base64 PNGs is ~30MB of CDP traffic,
 * and a file:// page cannot fetch them at all.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * sharp lives in web/node_modules, which a script in brand/ cannot reach — Node
 * resolves from the importing *file* upward, and there is no node_modules above
 * this one. So resolve it against the web package explicitly, and treat it as
 * optional: a missing sharp still leaves the WebM and the poster frame, which is
 * enough to see whether the ident works.
 */
const sharp = await (async () => {
  try {
    const req = createRequire(resolve(HERE, "../web/package.json"));
    return (await import(pathToFileURL(req.resolve("sharp")).href)).default;
  } catch (e) {
    console.warn(`sharp unavailable (${e.code ?? e.message}) — skipping GIF and WebP`);
    return null;
  }
})();

const CDP_PORT = 9224; // 9222 is web/.shots, 9223 is render.mjs
const HTTP_PORT = 9324;

const WIDTH = 1200;
const HEIGHT = 675; // 16:9 — the one ratio X shows uncropped
const FPS = 30;
const SECONDS = 5;
const FRAMES = FPS * SECONDS;

/**
 * In preference order. `isTypeSupported` is necessary but NOT sufficient, in two
 * separate ways: this Chrome answers true for `video/mp4;codecs=avc1` and then
 * records zero bytes, and answers true for `video/mp4` and then hands back an MP4
 * with a VP9 track in it. So each candidate is tried for real and judged on the
 * bytes it produces — both the size and the sample-entry fourcc.
 */
const MIMES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
];

/** Everything the page is allowed to write, so a POST cannot pick its own path. */
const WRITABLE = new Set(["x-curve.mp4", "x-curve.webm", "x-curve.mkv"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ─── The scratch server ──────────────────────────────────────────────────────

/** Captured PNGs, indexed by frame. Filled in stage 1, served during stage 2. */
const frames = [];

const RECORDER = `<!doctype html><meta charset="utf-8"><title>encode</title>
<body style="margin:0;background:#111">
<script>
/**
 * Draw the captured frames into a canvas at 1/fps and record the canvas.
 *
 * captureStream(0) means the stream produces a frame only when asked, so the
 * sleep between requestFrame() calls *is* the frame duration in the output. A
 * captureStream(fps) would instead let the encoder sample the canvas on its own
 * schedule and duplicate or drop frames when a decode ran long.
 */
window.encode = async function encode({ count, fps, width, height, mimes, bitrate }) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  document.body.append(canvas);
  const ctx = canvas.getContext("2d", { alpha: false });

  // Decoded up front, and reused across every codec attempt: a decode stall
  // mid-recording would stretch that frame's wall-clock duration, and wall clock
  // is the timeline here.
  const bitmaps = [];
  for (let i = 0; i < count; i++) {
    const res = await fetch("/frames/" + i + ".png");
    if (!res.ok) throw new Error("frame " + i + ": " + res.status);
    bitmaps.push(await createImageBitmap(await res.blob()));
  }

  async function once(mime) {
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => (rec.onstop = r));
    const failed = new Promise((_, rej) => (rec.onerror = (e) => rej(new Error(String(e.error)))));

    const started = performance.now();
    rec.start();
    const step = 1000 / fps;
    for (let i = 0; i < count; i++) {
      const due = started + i * step;
      ctx.drawImage(bitmaps[i], 0, 0, width, height);
      track.requestFrame();
      // Sleep to the frame's *scheduled* time rather than for a fixed step, so a
      // slow drawImage steals from its own frame instead of lengthening the video.
      const left = due + step - performance.now();
      if (left > 0) await new Promise((r) => setTimeout(r, left));
    }
    // The last requestFrame() has no successor to end it, so hold before stopping
    // or the final frame gets a near-zero duration and the verdict never shows.
    await new Promise((r) => setTimeout(r, 400));
    const elapsed = performance.now() - started;

    rec.stop();
    await Promise.race([stopped, failed]);
    track.stop();
    return { blob: new Blob(chunks, { type: mime }), elapsed: Math.round(elapsed) };
  }

  const tried = [];
  for (const mime of mimes) {
    if (!MediaRecorder.isTypeSupported(mime)) { tried.push(mime + ": unsupported"); continue; }
    let got;
    try {
      got = await once(mime);
    } catch (e) {
      tried.push(mime + ": " + e.message);
      continue;
    }
    // A container Chrome will name but not fill comes back empty or near-empty.
    if (got.blob.size < 4096) { tried.push(mime + ": " + got.blob.size + "B"); continue; }

    // The container is not the codec, and size alone does not tell them apart.
    // Asked for plain "video/mp4" this Chrome returns a *well-formed* MP4 with a
    // VP9 track in it — a file that looks like the deliverable and that X rejects
    // at upload with no useful error. Read the sample-entry fourcc and insist on
    // H.264 before calling anything an MP4.
    const bytes = new Uint8Array(await got.blob.arrayBuffer());
    if (mime.startsWith("video/mp4") && !fourcc(bytes, "avc1") && !fourcc(bytes, "hvc1")) {
      const found = ["vp09", "vp08", "av01"].find((c) => fourcc(bytes, c));
      tried.push(mime + ": " + (found ?? "unknown codec") + " track in mp4, not H.264");
      continue;
    }

    const ext = mime.startsWith("video/mp4") ? "mp4"
      : mime.startsWith("video/webm") ? "webm"
      : "mkv";
    const name = "x-curve." + ext;
    const put = await fetch("/out/" + name, { method: "POST", body: got.blob });
    if (!put.ok) throw new Error("write " + name + ": " + put.status);
    return { mime, ext, name, bytes: got.blob.size, elapsed: got.elapsed, tried };
  }
  return { mime: null, tried };
};

/** An ASCII fourcc anywhere in a byte buffer — enough to find an MP4 sample entry. */
function fourcc(bytes, code) {
  const n = [...code].map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i + n.length <= bytes.length; i++) {
    for (let j = 0; j < n.length; j++) if (bytes[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}
</script>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (code, type, body) => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };

  if (url.pathname === "/curve-anim.html") {
    return send(200, "text/html; charset=utf-8", readFileSync(resolve(HERE, "curve-anim.html")));
  }
  if (url.pathname === "/recorder.html") {
    return send(200, "text/html; charset=utf-8", RECORDER);
  }
  const frame = url.pathname.match(/^\/frames\/(\d+)\.png$/);
  if (frame) {
    const png = frames[Number(frame[1])];
    return png ? send(200, "image/png", png) : send(404, "text/plain", "no frame");
  }
  const out = url.pathname.match(/^\/out\/([\w.-]+)$/);
  if (out && req.method === "POST") {
    if (!WRITABLE.has(out[1])) return send(403, "text/plain", "not writable");
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      writeFileSync(resolve(HERE, out[1]), Buffer.concat(parts));
      send(200, "text/plain", "ok");
    });
    return;
  }
  send(404, "text/plain", "no");
});
await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));

// ─── Chrome ──────────────────────────────────────────────────────────────────

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => existsSync(p));
if (!CHROME) throw new Error("chrome not found");

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${CDP_PORT}`,
  "--hide-scrollbars",
  "--no-first-run",
  "--force-color-profile=srgb",
  "--mute-audio",
  "--autoplay-policy=no-user-gesture-required",
  // Stage 2's timeline *is* setTimeout, so throttling it would stretch the
  // video. A headless page is not reliably treated as foreground.
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--user-data-dir=" + resolve(HERE, ".chrome-anim"),
  "about:blank",
]);
chrome.on("error", (e) => console.error("chrome:", e.message));

let target;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page");
    if (target) break;
  } catch {}
}
if (!target) throw new Error("no CDP target");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: res, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((res, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve: res, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

await send("Page.enable");
await send("Runtime.enable");

const evaluate = async (expression, timeout = 240_000) => {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
  return r.result.value;
};

// ─── Stage 1: capture ────────────────────────────────────────────────────────

await send("Emulation.setDeviceMetricsOverride", {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 1 } });
await send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/curve-anim.html` });
// The three brand families come from Google Fonts; a frame captured before they
// land is a frame set in Georgia, and it would sit in the middle of the video.
await evaluate("document.fonts.ready.then(() => document.fonts.size)");
await sleep(600);

const capturedAt = process.hrtime.bigint();
for (let i = 0; i < FRAMES; i++) {
  const t = i / (FRAMES - 1);
  await evaluate(`window.frame(${t});`);
  const { data } = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  frames[i] = Buffer.from(data, "base64");
}
const captureMs = Number(process.hrtime.bigint() - capturedAt) / 1e6;
const totalBytes = frames.reduce((n, f) => n + f.length, 0);
log(
  `captured   ${FRAMES} frames  ${WIDTH}×${HEIGHT}  ${(totalBytes / 1e6).toFixed(1)}MB raw  ${Math.round(captureMs)}ms`,
);

// A still of the payoff frame, for anywhere a video will not play — and as the
// thumbnail X shows before the user scrolls it into autoplay.
writeFileSync(resolve(HERE, "x-curve-poster.png"), frames[FRAMES - 1]);
log(`x-curve-poster.png  ${WIDTH}×${HEIGHT}  final frame, for thumbnails and fallbacks`);

// ─── Stage 2a: video, via MediaRecorder ──────────────────────────────────────

await send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/recorder.html` });
await sleep(300);
const vid = await evaluate(
  `window.encode(${JSON.stringify({
    count: FRAMES,
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    mimes: MIMES,
    bitrate: 8_000_000,
  })})`,
);
for (const note of vid.tried) log(`  rejected  ${note}`);
if (!vid.mime) {
  // Not fatal: the GIF below is a real X asset (X transcodes uploaded GIFs to
  // MP4 server-side and autoplays them), so a missing video codec costs quality,
  // not the deliverable.
  log("no working video codec — GIF is the postable motion asset");
} else {
  const drift = vid.elapsed - (SECONDS * 1000 + 400);
  log(
    `${vid.name.padEnd(20)}${(vid.bytes / 1e6).toFixed(2)}MB  ${vid.mime}  ` +
      `wall ${vid.elapsed}ms (${drift >= 0 ? "+" : ""}${drift}ms vs ${SECONDS}s+hold)` +
      (vid.ext === "mp4" ? "" : "  — X will not accept this container"),
  );
}

ws.close();
chrome.kill();
server.close();

// ─── Stage 2b: animated stills, via sharp ────────────────────────────────────

/**
 * Join frames into one animated file. sharp needs every frame at the same size,
 * so each is resized on its own before the join.
 *
 * `delay` must be an array: given a scalar, sharp applies it to the first frame
 * only and the rest arrive at 0ms, which plays as a flash and a freeze.
 */
async function animate({ every, width, encode, name, note }) {
  const picked = frames.filter((_, i) => i % every === 0);
  const scaled = await Promise.all(
    picked.map((f) => sharp(f).resize({ width }).png({ compressionLevel: 1 }).toBuffer()),
  );
  const delay = Array(scaled.length).fill(Math.round(1000 / (FPS / every)));
  const out = await encode(
    sharp(scaled, { join: { animated: true } }),
    delay,
  ).toBuffer();
  writeFileSync(resolve(HERE, name), out);
  log(
    `${name.padEnd(20)}${(out.length / 1e6).toFixed(2)}MB  ` +
      `${scaled.length} frames @ ${Math.round(FPS / every)}fps  ${note}`,
  );
}

if (sharp) {
  await animate({
    every: 1,
    width: 1000,
    name: "x-curve.webp",
    note: "the site — animated WebP, alpha-free, every browser since 2020",
    encode: (img, delay) => img.webp({ delay, loop: 0, quality: 62, effort: 4 }),
  });

  // GIF is the only one of these that pastes into Discord, Telegram and a GitHub
  // README and just plays — which is worth the palette and the file size. Third
  // of the frame rate and two thirds of the width to keep it under a few MB.
  await animate({
    every: 3,
    width: 800,
    name: "x-curve.gif",
    note: "Discord, Telegram, READMEs — 128-colour palette",
    encode: (img, delay) =>
      img.gif({ delay, loop: 0, colours: 128, effort: 7, dither: 1, interFrameMaxError: 8 }),
  });
}

process.exit(0);
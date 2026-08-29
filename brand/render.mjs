#!/usr/bin/env node
/**
 * Rasterises the brand sources into the PNGs the platforms actually want.
 *
 *   node brand/render.mjs
 *
 * Headless Chrome over CDP, because the banner is a real page — the same web
 * fonts and the same gradients as the app — and only a browser draws it the way
 * the site does. The SVGs go through the same path so the mark on the banner and
 * the mark in the avatar are the identical drawing at different sizes.
 *
 * Everything lands next to its source in `brand/`, deliberately flat: these are
 * files someone uploads to X, not build artefacts. (`brand/out/` would also be
 * swallowed by the repo's Foundry `out/` rule.)
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 9223; // not 9222 — the screenshot harness in web/.shots uses that

/** Wrap an SVG file in a page so Chrome scales it to any size we ask for. */
const wrap = (file, size) => `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent}
  svg{display:block;width:${size}px;height:${size}px}
</style>
${readFileSync(resolve(HERE, file), "utf8")}`;

/**
 * scheme only matters for mark.svg, which carries a prefers-color-scheme rule so
 * it can sit on a browser tab we do not get to paint.
 */
const JOBS = [
  {
    name: "mark-1024.png",
    html: () => wrap("mark.svg", 1024),
    width: 1024,
    height: 1024,
    transparent: true,
    note: "the mark for dark backgrounds",
  },
  {
    name: "mark-light-1024.png",
    html: () => wrap("mark.svg", 1024),
    width: 1024,
    height: 1024,
    transparent: true,
    scheme: "light",
    note: "the same mark, inked for cream backgrounds",
  },
  {
    name: "mark-plate-400.png",
    html: () => wrap("mark-plate.svg", 400),
    width: 400,
    height: 400,
    note: "X profile picture (X wants ≥400×400 and crops to a circle)",
  },
  {
    name: "mark-plate-1024.png",
    html: () => wrap("mark-plate.svg", 1024),
    width: 1024,
    height: 1024,
    note: "the plate at app-icon size — Discord, GitHub, anywhere square",
  },
  {
    // Next serves `app/apple-icon.png` as the iOS home-screen icon, which is
    // composited on whatever wallpaper is behind it — so it takes the opaque
    // plate rather than the transparent mark.
    name: "../web/app/apple-icon.png",
    html: () => wrap("mark-plate.svg", 180),
    width: 180,
    height: 180,
    note: "iOS home screen, via Next's app/apple-icon convention",
  },
  {
    name: "x-banner-1500x500.png",
    url: pathToFileURL(resolve(HERE, "banner.html")).href,
    width: 1500,
    height: 500,
    note: "X header, at the size X documents",
  },
  {
    name: "x-banner-3000x1000.png",
    url: pathToFileURL(resolve(HERE, "banner.html")).href,
    width: 1500,
    height: 500,
    scale: 2,
    note: "the same header at 2× — sharper once X re-encodes it",
  },
  // The introduction card: the underwater.fun × InkChain lockup, for the account's
  // first post and, at 1500×500, for the header behind it.
  {
    name: "x-intro-1600x900.png",
    url: `${pathToFileURL(resolve(HERE, "intro.html")).href}#post`,
    width: 1600,
    height: 900,
    note: "introduction post — the × InkChain lockup",
  },
  {
    name: "x-intro-3200x1800.png",
    url: `${pathToFileURL(resolve(HERE, "intro.html")).href}#post`,
    width: 1600,
    height: 900,
    scale: 2,
    // X re-encodes every upload; giving it more pixels than it needs is the only
    // lever on how the display type survives that.
    note: "the same card at 2× — upload this one if X takes it",
  },
  {
    name: "x-intro-header-1500x500.png",
    url: `${pathToFileURL(resolve(HERE, "intro.html")).href}#header`,
    width: 1500,
    height: 500,
    note: "the lockup as a profile header",
  },
  // The post cards, one per fragment. 1600×900 is the one ratio X shows
  // uncropped in a timeline; see brand/x-launch.md for which post each goes with.
  ...["curve", "graduation", "fees"].map((card) => ({
    name: `x-post-${card}.png`,
    url: `${pathToFileURL(resolve(HERE, "posts.html")).href}#${card}`,
    width: 1600,
    height: 900,
    note: `post card — ${card}`,
  })),
  // The six standalone plates from brand/x-growth.md. Same size and same
  // scaffolding as the post cards above; the difference is that these are the
  // sentence set large rather than a figure, which is the point argued in the
  // header comment of plates.html.
  ...["spec", "teaser", "question", "locked", "everyfee", "chain"].map((card) => ({
    name: `x-plate-${card}.png`,
    url: `${pathToFileURL(resolve(HERE, "plates.html")).href}#${card}`,
    width: 1600,
    height: 900,
    note: `voice plate — ${card}`,
  })),
  // The Underwater Plates sneak peeks. Unlike every card above, these carry real
  // renderer output rather than type — see the header comment of nft.html for why
  // a mockup was not an option for this collection in particular.
  ...["collection", "dissolve", "drown", "sealed", "provenance", "rarity"].map((card) => ({
    name: `x-nft-${card}.png`,
    url: `${pathToFileURL(resolve(HERE, "nft.html")).href}#${card}`,
    width: 1600,
    height: 900,
    note: `plates sneak peek — ${card}`,
  })),
  {
    name: "x-nft-header-1500x500.png",
    url: `${pathToFileURL(resolve(HERE, "nft.html")).href}#header`,
    width: 1500,
    height: 500,
    note: "the plates drop as a profile header",
  },
];

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => existsSync(p));
if (!CHROME) throw new Error("chrome not found");

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  "--hide-scrollbars",
  "--no-first-run",
  "--force-color-profile=srgb",
  "--user-data-dir=" + resolve(HERE, ".chrome"),
  "about:blank",
]);
chrome.on("error", (e) => console.error("chrome:", e.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

for (const job of JOBS) {
  await send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: job.scheme ?? "dark" },
      // No animations to catch mid-flight; nothing here animates, but a plate
      // should never depend on when the shutter opened.
      { name: "prefers-reduced-motion", value: "reduce" },
    ],
  });
  await send("Emulation.setDeviceMetricsOverride", {
    width: job.width,
    height: job.height,
    deviceScaleFactor: job.scale ?? 1,
    mobile: false,
  });
  // Transparency is opt-in: without this override Chrome paints white behind the
  // page and the mark arrives on a white square.
  await send("Emulation.setDefaultBackgroundColorOverride", {
    color: job.transparent
      ? { r: 0, g: 0, b: 0, a: 0 }
      : { r: 0, g: 0, b: 0, a: 1 },
  });

  if (job.url) {
    await send("Page.navigate", { url: job.url });
  } else {
    const { frameTree } = await send("Page.getFrameTree");
    await send("Page.setDocumentContent", {
      frameId: frameTree.frame.id,
      html: job.html(),
    });
  }

  // Web fonts are fetched from Google, so the shutter waits on them rather than
  // on a guess: a banner captured early is a banner set in Georgia.
  await evaluate("document.fonts.ready.then(() => document.fonts.size)");
  // And on the images, for the same reason one step further out. The plates cards
  // load six SVGs apiece, each running a feTurbulence displacement map; `decode()`
  // resolves only once a frame is ready to paint, so a card cannot ship with a
  // plate still blank. `catch` because a decode that fails should show up as a
  // hole in the PNG under review, not as a thrown render.
  await evaluate(
    "Promise.all([...document.images].map((i) => i.decode().catch(() => {}))).then(() => document.images.length)",
  );
  await sleep(job.url ? 900 : 250);

  const { data } = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const file = resolve(HERE, job.name);
  writeFileSync(file, Buffer.from(data, "base64"));
  const px = `${job.width * (job.scale ?? 1)}×${job.height * (job.scale ?? 1)}`;
  console.log(`${job.name.padEnd(26)} ${px.padEnd(11)} ${job.note}`);
}

ws.close();
chrome.kill();

// The favicon is the mark itself, not a render of it: Next serves `app/icon.svg`
// verbatim, and an SVG on a browser tab is the one place the theme rule inside it
// actually gets read. Copied rather than referenced so the app has no build-time
// dependency on this folder.
copyFileSync(resolve(HERE, "mark.svg"), resolve(HERE, "../web/app/icon.svg"));
console.log(`${"../web/app/icon.svg".padEnd(26)} ${"vector".padEnd(11)} favicon`);

process.exit(0);

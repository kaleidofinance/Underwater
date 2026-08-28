"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { clock, effect, frameLoop, init, surface } from "vgpu";
import { readDepth, readPalette } from "./palette";
import { WATER_WGSL } from "./water.wgsl";

/**
 * The water as WebGPU, drawn into one fixed full-viewport canvas.
 *
 * This module is the only thing in the app that imports `vgpu`, which is the
 * whole reason it is a module of its own: WaterLayer reaches it through a
 * `dynamic()` import, so the library lands in its own chunk and a visitor with
 * the flag off never downloads a byte of it. Putting the import in a file the
 * root layout pulls in directly would put vgpu in every route's first load,
 * flag or no flag — a runtime boolean cannot tree-shake a static import.
 *
 * It replaces `.water` and `.shafts` at once. Both exist to be composited, one
 * as a tint over the paper and one screen-blended on top, and doing that in a
 * fragment shader is a line of arithmetic — so there is no reason for two
 * elements, and one opaque canvas is cheaper to composite than two stacked
 * layers with a blend mode.
 *
 * Nothing here runs on the server. That is not carefulness, it is structural:
 * WaterLayer loads this with `ssr: false`, so no markup for it exists in the
 * HTML for the client to disagree with. The alternative — render the canvas and
 * gate on `navigator.gpu` — is the shape of the hydration bug this app already
 * had once, where the server's answer to a browser-only question ended up in the
 * markup.
 */
export default function WaterCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const waterRef = useRef<ReturnType<typeof effect> | null>(null);
  const markDirty = useRef<(() => void) | null>(null);
  const pathname = usePathname();
  const [live, setLive] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    // Strict mode mounts effects twice in development, so every one of these has
    // to be releasable: skipping it leaks a GPU device and a render loop per
    // remount, and the second device is the one that keeps drawing.
    let disposed = false;
    let stop: (() => void) | undefined;
    let dispose: (() => void) | undefined;
    let offResize: (() => void) | undefined;
    let offScheme: (() => void) | undefined;

    (async () => {
      try {
        const gpu = await init();
        if (disposed) {
          gpu.dispose();
          return;
        }
        dispose = () => gpu.dispose();

        // DPR clamped hard. This is a background: at 3x on a phone it would be
        // shading nine times the pixels of the content drawn over it.
        const view = surface(gpu, canvas, { dpr: [1, 1.5] });
        const texel = (): [number, number] => [
          1 / view.size[0],
          1 / view.size[1],
        ];
        const aspect = () => view.size[0] / view.size[1];

        // Reduced motion is honoured by not moving, rather than by not drawing:
        // globals.css already kills every transition and animation site-wide, so
        // an animated background would be the one thing that ignored the setting.
        const still = window.matchMedia("(prefers-reduced-motion: reduce)");

        const water = effect(gpu, WATER_WGSL, {
          label: "water",
          set: {
            p: {
              ...readPalette(),
              ...readDepth(),
              texel: texel(),
              aspect: aspect(),
              time: 0,
              motion: still.matches ? 0 : 1,
            },
          },
        });

        // Pipelines compile on first draw. Doing it here instead means the first
        // frame the visitor sees is not the one that stalls to compile a shader.
        //
        // By signature, not by passing `view`: a surface only exposes its texture
        // inside a frame, so `compile(view)` throws `Surface targets are only
        // available inside frame(gpu)` — the format and sample count are the two
        // things it actually needs and both are readable out here. Failing this
        // is survivable, so it gets its own catch: the first frame would compile
        // the pipeline anyway, and losing the whole water layer over a dropped
        // optimisation would be the worse trade.
        try {
          await water.compile({
            colors: [view.format],
            sampleCount: view.sampleCount,
          });
        } catch (warm) {
          if (process.env.NODE_ENV !== "production") {
            console.warn("[water] pre-warm skipped:", warm);
          }
        }
        if (disposed) {
          gpu.dispose();
          return;
        }
        waterRef.current = water;

        const t = clock(gpu);

        // `dirty` is what makes reduced motion cost nothing. Zeroing `motion`
        // already freezes the picture — every use of `time` in the shader is
        // multiplied by it — but a frozen picture redrawn thirty times a second
        // is still a full-screen fragment pass thirty times a second, which is
        // the battery cost the preference exists to avoid. So in that mode the
        // callback draws once and then only when something has actually changed.
        //
        // Done with a flag rather than by stopping the loop because a one-shot
        // `frame()` cannot be called from a resize callback — it throws
        // VGPU-FRAME-REENTRANT, and onResize fires immediately on subscribe. An
        // idle rAF tick that returns early is a function call; the pass is not.
        let dirty = true;
        let revealed = false;
        // Exposed so the navigation effect below can ask for a redraw. Without
        // it a route change would update the depth uniform and, under reduced
        // motion, never draw the frame that shows it.
        markDirty.current = () => {
          dirty = true;
        };

        // 30fps: this is scenery behind a page that is already polling the chain
        // and redrawing a candlestick chart. A hidden tab costs nothing either —
        // the loop is driven by requestAnimationFrame, which browsers do not fire
        // for backgrounded tabs, so no visibility handling is needed here.
        const loop = frameLoop(
          gpu,
          (frame) => {
            // Read per frame, so flipping the OS setting takes effect without a
            // reload rather than being latched at startup.
            const moving = !still.matches;
            if (!moving && !dirty) return;
            dirty = false;

            water.set({ p: { time: moving ? t.time : 0, motion: moving ? 1 : 0 } });
            frame.pass(view, water);

            // The reveal waits for real pixels. Adding the class when `init()`
            // resolved would start the crossfade against a canvas that has not
            // been drawn into yet — the gradient fading out under a blank frame.
            if (!revealed) {
              revealed = true;
              document.documentElement.classList.add("shader-water");
              setLive(true);
            }
          },
          { fps: 30 },
        );
        stop = () => loop.stop();

        // Subscribed after the loop is running: onResize fires once immediately,
        // and a frame started from inside a resize callback throws.
        offResize = view.onResize(() => {
          water.set({ p: { texel: texel(), aspect: aspect() } });
          dirty = true;
        });

        // The palette flips wholesale between the light and dark blocks, so the
        // theme changing means re-reading it rather than interpolating anything.
        //
        // Two ways it can change, and both need watching. The OS preference is a
        // media query; an explicit choice is `data-theme` on <html>, which
        // components/ThemeToggle.tsx sets and no media query reports. Watching
        // only the first left the water in yesterday's palette every time someone
        // pressed the toggle, until a resize happened to refresh it.
        const scheme = window.matchMedia("(prefers-color-scheme: light)");
        const onScheme = () => {
          water.set({ p: readPalette() });
          dirty = true;
        };
        scheme.addEventListener("change", onScheme);
        // `attributeFilter` matters: this component puts `shader-water` on the
        // same element, so an unfiltered observer would answer its own writes.
        const themeAttr = new MutationObserver(onScheme);
        themeAttr.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });
        // The motion query needs one too: going from reduce to no-reduce has to
        // wake the loop back up, and the reverse needs one last frame to settle
        // the picture at time 0 instead of leaving it wherever it stopped.
        const onStill = () => {
          dirty = true;
        };
        still.addEventListener("change", onStill);
        offScheme = () => {
          scheme.removeEventListener("change", onScheme);
          still.removeEventListener("change", onStill);
          themeAttr.disconnect();
        };
      } catch (err) {
        // No WebGPU, no adapter, or a shader vgpu will not take. There is
        // nothing to recover: the CSS water is already painted underneath.
        //
        // Said out loud in development, though, because the silent version makes
        // "this machine has no WebGPU" and "your WGSL does not compile" look
        // exactly alike — and one of those is a bug someone needs to see.
        if (process.env.NODE_ENV !== "production") {
          console.warn("[water] shader layer did not start:", err);
        }
      }
    })();

    return () => {
      disposed = true;
      waterRef.current = null;
      markDirty.current = null;
      offScheme?.();
      offResize?.();
      stop?.();
      dispose?.();
      document.documentElement.classList.remove("shader-water");
    };
  }, []);

  // `--t` and `--lev` are set per page as an inline style on `.shell`, which the
  // canvas is a sibling of and inherits nothing from. Re-read on navigation —
  // the depth belongs to the route, so that is exactly how often it changes.
  useEffect(() => {
    const water = waterRef.current;
    if (!water) return;
    // Deferred a frame: this effect runs as the new route commits, and `.shell`
    // carries its inline style only once React has actually put it in the
    // document. Reading in the same tick gets the outgoing page's depth.
    const id = requestAnimationFrame(() => {
      water.set({ p: readDepth() });
      markDirty.current?.();
    });
    return () => cancelAnimationFrame(id);
  }, [pathname, live]);

  return (
    <canvas
      ref={ref}
      className="water-gl"
      aria-hidden="true"
      data-live={live || undefined}
    />
  );
}

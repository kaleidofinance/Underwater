/**
 * Cut a picked image down to something the pinning route can actually receive.
 *
 * That route is a serverless function, and a serverless function on Vercel is
 * never handed a request body over 4.5 MB — the platform answers 413 itself,
 * before any of our code runs. So the route could not explain the failure even in
 * principle: there is no request for it to read, which is why the reader used to
 * get a bare `Upload failed (413)` after filling in the whole form and waiting
 * out the upload. A photograph off a phone clears 4.5 MB on its own, so the
 * banner field was a trap that only sprang at the end.
 *
 * The bytes are therefore cut here, in the browser, where the original still
 * exists and the size the token page actually draws is known. A 12 MP photo
 * becomes the ~1900px image the banner is rendered at, a couple of hundred
 * kilobytes instead of eight megabytes — the limit stops being reachable rather
 * than being reported more politely.
 *
 * Two formats are handed through untouched, because a canvas would not resize
 * them so much as replace them: an SVG is a description of a drawing, and
 * rasterising it fixes it at one size forever; an animated GIF comes back as its
 * first frame. Neither can be made smaller here without becoming a different
 * image, so they are only measured against the budget.
 *
 * Nothing is ever re-encoded *to* WebP, even though it would be the smallest of
 * the three. The pinned logo is fetched back and drawn into the share cards by
 * Satori — see `fetchArt` in lib/og-data.ts — and Satori's list of image formats
 * is short and does not include it. A format the card cannot draw is worse than a
 * file a few kilobytes larger, so output is PNG or JPEG: the same set the form has
 * always named. The same reasoning applies in reverse, which is a small bug fixed
 * in passing — a `.webp` logo picked today is pinned as-is and its share card
 * cannot draw it, whereas now it comes out as one of the two formats that work.
 */

/** Formats a canvas cannot re-encode without making them a different image. */
const PASSTHROUGH = /^image\/(svg\+xml|gif)$/i;

/**
 * Encoder qualities, tried in order until one fits the budget.
 *
 * Only JPEG reads this — `toBlob` ignores the argument for PNG, so the PNG path
 * has one rung and gets smaller by losing pixels instead.
 */
const QUALITY = [0.9, 0.82, 0.72, 0.6];

/** What the longest edge is multiplied by when a whole quality ladder missed. */
const SHRINK = 0.7;
/** How many times that may happen before the image is refused outright. */
const ROUNDS = 3;

/** Bytes as a reader would say them: `412 KB`, `1.5 MB`, `4 MB`. */
export const fmtBytes = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")} MB`
    : `${Math.max(1, Math.round(n / 1_000))} KB`;

export type FitSpec = {
  /** The longest edge the result may keep, in pixels. */
  edge: number;
  /** The byte ceiling the result has to come in under. */
  budget: number;
  /** How this image is named in an error the reader will read. */
  label: string;
};

/**
 * The picked file, resized and re-encoded to fit `budget`, or the file itself
 * when it already fits and has nothing to gain.
 *
 * Throws with a sentence worth showing when the image cannot be made to fit —
 * which after the ladder below means an SVG or an animated GIF that is simply too
 * big, since anything a canvas can draw compresses.
 */
export async function fitImage(file: File, { edge, budget, label }: FitSpec): Promise<File> {
  if (PASSTHROUGH.test(file.type)) {
    if (file.size <= budget) return file;
    const why = /gif/i.test(file.type)
      ? "resizing a GIF here would drop every frame after the first"
      : "rasterising an SVG would fix it at one size forever";
    throw new Error(
      `${label} is ${fmtBytes(file.size)}, over the ${fmtBytes(budget)} limit — and ${why}, so it is pinned exactly as picked. Use a smaller file, or a PNG or JPG.`,
    );
  }

  let bitmap: ImageBitmap;
  try {
    // `from-image` so a photo carrying an EXIF rotation is drawn the way its
    // camera meant it rather than on its side. Browsers have defaulted to this
    // for a while, but the default is what changed, so it is asked for.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // A CMYK JPEG, a 16-bit TIFF, a truncated download. Nothing can be resized,
    // so the only question left is whether what was picked already fits.
    if (file.size <= budget) return file;
    throw new Error(
      `${label} could not be read as an image here — it is ${fmtBytes(file.size)} and would need to be under ${fmtBytes(budget)}. Try a PNG or JPG.`,
    );
  }

  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const fits = Math.min(1, edge / longest);
    // Small in both senses already: re-encoding could only cost quality.
    if (fits === 1 && file.size <= budget) return file;

    for (let round = 0; round < ROUNDS; round++) {
      const canvas = draw(bitmap, fits * SHRINK ** round);
      const type = encodingFor(file, canvas);
      for (const quality of QUALITY) {
        const blob = await encode(canvas, type, quality);
        if (!blob) break;
        if (blob.size <= budget) return named(file, blob);
        // PNG ignores quality, so the rest of the ladder is the same bytes.
        if (type === "image/png") break;
      }
    }

    throw new Error(
      `${label} could not be compressed under ${fmtBytes(budget)}. Try a smaller or simpler image.`,
    );
  } finally {
    bitmap.close();
  }
}

/** The bitmap, scaled, on a canvas. */
function draw(bitmap: ImageBitmap, scale: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot resize images.");
  // The default downscale is a fast box filter, which at these ratios visibly
  // aliases a logo's edges. One image per pick — there is no budget to save here.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Which of the two formats to write.
 *
 * JPEG is far smaller and is the right answer for anything photographic, but it
 * has no alpha — and a logo is the one image on this form most likely to be a
 * cut-out, where flattening the transparency would put a black square behind the
 * mark on every page that draws it. So a source that cannot have alpha (JPEG) is
 * kept as JPEG, and anything else is asked whether it actually uses any.
 */
function encodingFor(file: File, canvas: HTMLCanvasElement): "image/jpeg" | "image/png" {
  if (/^image\/jpe?g$/i.test(file.type)) return "image/jpeg";
  return hasAlpha(canvas) ? "image/png" : "image/jpeg";
}

/** Whether any pixel is less than fully opaque. */
function hasAlpha(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx) return true;
  // Reading pixels back is only allowed on an untainted canvas. This one was
  // drawn from a local File, which is not cross-origin, so it never taints.
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

/** `toBlob` as a promise. Resolves null when the browser refuses to encode. */
function encode(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** The blob as a File, keeping the original's name with the new extension. */
function named(source: File, blob: Blob): File {
  const stem = (source.name || "image").replace(/\.[^.]+$/, "");
  const ext = blob.type === "image/png" ? "png" : "jpg";
  return new File([blob], `${stem}.${ext}`, { type: blob.type });
}

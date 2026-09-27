/**
 * Token images: fit in the browser, then upload to the ZEC API.
 *
 * Stills are redrawn on a canvas and re-encoded, which does two jobs: it gets
 * them under the server's size limit, and it drops everything but the pixels,
 * EXIF included. A phone photo's EXIF can carry the GPS position it was taken
 * at, which is exactly what a Zcash user doesn't want published next to their
 * token. GIFs are sent as picked, because a canvas would keep only the first
 * frame. SVG is refused: it's a document that can carry script.
 */
import { ZEC_API, zecSigned } from "./api";

/** Must match DEFAULT_IMAGE_LIMITS.maxBytes in zec/server/images.ts. */
export const IMAGE_MAX_BYTES = 256 * 1024;
/** Tokens show at 56 px at most; 512 is sharp on any screen and small on the wire. */
const EDGE = 512;
const QUALITY = [0.9, 0.8, 0.7, 0.55];
const ACCEPT = /^image\/(png|jpeg|webp|gif)$/;

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

/** The image as it will be uploaded: resized and re-encoded, or a GIF as-is. */
export async function fitImage(file: File): Promise<Blob> {
  if (!ACCEPT.test(file.type)) throw new Error("Pick a PNG, JPG, WebP or GIF.");
  if (file.type === "image/gif") {
    if (file.size <= IMAGE_MAX_BYTES) return file;
    throw new Error(`That GIF is ${kb(file.size)}; GIFs are sent as they are, so it has to be under ${kb(IMAGE_MAX_BYTES)}.`);
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("That file couldn't be read as an image.");
  }
  try {
    const scale = Math.min(1, EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser can't resize images.");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    for (const quality of QUALITY) {
      const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/webp", quality));
      // A browser that can't encode WebP hands back a PNG instead, which quality doesn't shrink.
      if (blob && blob.size <= IMAGE_MAX_BYTES) return blob;
      if (!blob || blob.type !== "image/webp") break;
    }
    const jpeg = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.8));
    if (jpeg && jpeg.size <= IMAGE_MAX_BYTES) return jpeg;
    throw new Error(`That image couldn't be brought under ${kb(IMAGE_MAX_BYTES)}. Try a simpler one.`);
  } finally {
    bitmap.close();
  }
}

/** Upload a fitted image. Returns the metadataURI a launch should carry. */
export async function uploadImage(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const r = await zecSigned<{ uri: string }>("POST", "/api/images", { data: btoa(binary) });
  return r.uri;
}

/** Where to load a token's image from, or null when it has none of ours. */
export function imageSrc(metadataURI: string): string | null {
  return /^\/api\/images\/[0-9a-f]{64}\.(png|jpg|gif|webp)$/.test(metadataURI) ? ZEC_API + metadataURI : null;
}

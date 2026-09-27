/**
 * Token images, stored by the API itself.
 *
 * Content-addressed: an image's id is the sha256 of its bytes plus its
 * format, so the same picture uploaded twice is stored once, and a stored
 * image can never change under the tokens that point at it. Only PNG, JPEG,
 * GIF and WebP are accepted, identified by their magic bytes rather than by
 * anything the uploader claims. SVG never is: an SVG is a document that can
 * carry script. The browser re-encodes stills before upload (web/lib/zec/
 * image.ts), which also strips EXIF data such as GPS location.
 *
 * The images share a disk with the engine's log, and a full disk would stop
 * the log accepting commands. So the store has a hard total cap, and each
 * account a daily upload quota.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EngineError } from "../engine/index.ts";

export type ImageFormat = "png" | "jpg" | "gif" | "webp";

export const IMAGE_TYPES: Record<ImageFormat, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** `/api/images/<id>`: what a token's metadataURI holds when its image is ours. */
export const IMAGE_ID = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/;
export const IMAGE_PATH = /^\/api\/images\/([0-9a-f]{64}\.(?:png|jpg|gif|webp))$/;

export interface ImageLimits {
  /** Largest single image, in bytes. */
  readonly maxBytes: number;
  /** Most the store may hold in total. */
  readonly totalBytes: number;
  /** Uploads per account per rolling day. Repeats of an image already stored don't count. */
  readonly perAccountPerDay: number;
}

export const DEFAULT_IMAGE_LIMITS: ImageLimits = Object.freeze({
  maxBytes: 256 * 1024,
  totalBytes: 150 * 1024 * 1024,
  perAccountPerDay: 30,
});

/** The format the bytes actually are, or null. */
export function sniff(b: Uint8Array): ImageFormat | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

export class ImageStore {
  readonly limits: ImageLimits;
  /** Null keeps images in memory: sim mode and tests. */
  readonly #dir: string | null;
  readonly #memory = new Map<string, Uint8Array>();
  readonly #uploads = new Map<string, number[]>();
  #used = 0;

  constructor(dir: string | null, limits: ImageLimits = DEFAULT_IMAGE_LIMITS) {
    this.limits = limits;
    this.#dir = dir;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      for (const f of readdirSync(dir)) if (IMAGE_ID.test(f)) this.#used += statSync(join(dir, f)).size;
    }
  }

  get usedBytes(): number {
    return this.#used;
  }

  /** Store `bytes` for `account`, returning the image's id. */
  put(account: string, bytes: Uint8Array, now: number): string {
    if (bytes.length === 0) throw new EngineError("InvalidArgument", "empty image");
    if (bytes.length > this.limits.maxBytes) {
      throw new EngineError("InvalidArgument", `images are at most ${Math.floor(this.limits.maxBytes / 1024)} KB`);
    }
    const format = sniff(bytes);
    if (!format) throw new EngineError("InvalidArgument", "not a PNG, JPEG, GIF or WebP image");
    const id = `${createHash("sha256").update(bytes).digest("hex")}.${format}`;
    if (this.has(id)) return id;

    const recent = (this.#uploads.get(account) ?? []).filter((t) => t > now - 86_400_000);
    if (recent.length >= this.limits.perAccountPerDay) {
      throw new EngineError("LimitExceeded", `at most ${this.limits.perAccountPerDay} image uploads a day`);
    }
    if (this.#used + bytes.length > this.limits.totalBytes) {
      throw new EngineError("LimitExceeded", "image storage is full; try again later");
    }

    if (this.#dir) {
      const path = join(this.#dir, id);
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, path); // a reader never sees half a file
    } else {
      this.#memory.set(id, bytes);
    }
    this.#used += bytes.length;
    recent.push(now);
    this.#uploads.set(account, recent);
    return id;
  }

  has(id: string): boolean {
    if (!IMAGE_ID.test(id)) return false;
    return this.#dir ? existsSync(join(this.#dir, id)) : this.#memory.has(id);
  }

  get(id: string): { bytes: Uint8Array; type: string } | null {
    if (!this.has(id)) return null;
    const bytes = this.#dir ? readFileSync(join(this.#dir, id)) : (this.#memory.get(id) ?? null);
    if (!bytes) return null;
    return { bytes, type: IMAGE_TYPES[id.split(".")[1] as ImageFormat] };
  }
}

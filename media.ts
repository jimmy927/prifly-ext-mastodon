/** Images for a post: read from disk before the card, uploaded only after the reader confirms. */

import { isAbsolute } from "node:path";
import { call } from "./client";
import type { LoadedFile } from "./deps";
import { UserError } from "./errors";
import type { Ctx } from "./store";
import type { StoredAccount } from "./types";

export const MAX_IMAGES = 4;

export type Image = { path: string; alt: string | undefined; file: LoadedFile };

/** `images` as the tool is given it: paths, or `{ path, alt }`; each read and checked. */
export async function loadImages(ctx: Ctx, value: unknown): Promise<Image[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new UserError("images must be a list of { path, alt } objects.");
  if (value.length > MAX_IMAGES) throw new UserError(`A post takes at most ${MAX_IMAGES} images.`);
  const images: Image[] = [];
  for (const entry of value as unknown[]) images.push(await loadImage(ctx, entry));
  return images;
}

async function loadImage(ctx: Ctx, entry: unknown): Promise<Image> {
  const item =
    typeof entry === "string" ? { path: entry } : (entry as { path?: unknown; alt?: unknown });
  if (typeof item.path !== "string" || !isAbsolute(item.path)) {
    throw new UserError("Each image needs a local absolute path.");
  }
  const alt = typeof item.alt === "string" && item.alt.trim() !== "" ? item.alt.trim() : undefined;
  const file = await ctx.deps.readFile(item.path);
  if (!/^(image|video|audio)\//.test(file.type)) {
    throw new UserError(
      `${item.path} is not an image Mastodon accepts (type ${file.type || "unknown"}).`,
    );
  }
  return { path: item.path, alt, file };
}

/** Uploads one image (POST /api/v2/media) and, on a 202, polls until the server has processed it. */
export async function uploadImage(ctx: Ctx, account: StoredAccount, image: Image): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([image.file.bytes], { type: image.file.type }), image.file.name);
  if (image.alt !== undefined) form.append("description", image.alt);
  const first = await call(ctx, account, "/api/v2/media", { method: "POST", form });
  const { id } = (await first.json()) as { id: string };
  if (first.status !== 202) return id;
  for (let attempt = 0; attempt < ctx.deps.mediaPollMax; attempt += 1) {
    await ctx.deps.sleep(ctx.deps.mediaPollMs);
    const polled = await call(ctx, account, `/api/v1/media/${id}`);
    // 206 means still processing; 200 means ready.
    if (polled.status === 200) return id;
  }
  throw new UserError(
    `${image.file.name} is still being processed by ${new URL(account.server).host} after ${ctx.deps.mediaPollMax} checks. Nothing was posted.`,
  );
}

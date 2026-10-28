/**
 * The writes: post, reply and DM. Each shows the reader a card with the
 * exact text, visibility, content warning, target and images, and sends
 * (uploads included) only on Confirm. On cancel the answer is exactly
 * "Not done: you cancelled".
 */

import type { ExtensionTool } from "@prifly/extension-api";
import { call, getJson } from "./client";
import { CANCELLED, UserError } from "./errors";
import { type Image, loadImages, uploadImage } from "./media";
import { htmlToText, who } from "./render";
import { resolveAccount, resolveStatusId } from "./resolve";
import { type Ctx, requireAccount } from "./store";
import { type Args, defineTool, optEnum, optStr, postText } from "./tool";
import {
  type Account,
  type Status,
  type StoredAccount,
  VISIBILITIES,
  type Visibility,
} from "./types";

type Draft = {
  kind: "post" | "reply" | "dm";
  text: string;
  visibility: Visibility;
  spoiler: string | undefined;
  inReplyTo: Status | undefined;
  recipient: Account | undefined;
  images: Image[];
};

const TITLES = {
  post: "Post to Mastodon",
  reply: "Reply on Mastodon",
  dm: "Direct message on Mastodon",
};

const excerpt = (status: Status) => {
  const text = htmlToText((status.reblog ?? status).content).replace(/\s+/g, " ");
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
};

function describe(draft: Draft, account: StoredAccount): { summary: string; details: string } {
  const host = new URL(account.server).host;
  const lines = [`Account: @${account.acct} on ${host}`, `Visibility: ${draft.visibility}`];
  lines.push(`Content warning: ${draft.spoiler ?? "none"}`);
  if (draft.inReplyTo) {
    const parent = draft.inReplyTo;
    lines.push(
      `Replying to: ${who(parent.account)} ${parent.url ?? parent.id} (id ${parent.id})`,
      `Their post: ${excerpt(parent)}`,
    );
  }
  if (draft.recipient)
    lines.push(`Direct message to: ${who(draft.recipient)} ${draft.recipient.url ?? ""}`.trimEnd());
  if (draft.visibility === "direct" && !draft.recipient) {
    lines.push("Direct: only the people @mentioned in the text will see it.");
  }
  if (draft.images.length === 0) lines.push("Images: none");
  draft.images.forEach((image, at) => {
    lines.push(
      `Image ${at + 1}: ${image.path} (${image.file.type}, ${image.file.bytes.length} bytes), alt text: ${image.alt ?? "none"}`,
    );
  });
  lines.push(`Request: POST ${host}/api/v1/statuses`);
  const target = draft.recipient
    ? ` to @${draft.recipient.acct}`
    : draft.inReplyTo
      ? ` to @${draft.inReplyTo.account.acct}`
      : "";
  const pics =
    draft.images.length > 0
      ? `, ${draft.images.length} image${draft.images.length === 1 ? "" : "s"}`
      : "";
  return {
    summary: `${TITLES[draft.kind]}${target}: ${draft.visibility}${draft.spoiler ? ", content warning" : ""}${pics}`,
    details: lines.join("\n"),
  };
}

/** Asks, and only on Confirm uploads the images and posts. */
async function send(ctx: Ctx, account: StoredAccount, draft: Draft): Promise<string> {
  const api = ctx.api();
  if (api?.confirm === undefined)
    return "Not done: this prifly cannot ask you first. Update prifly.";
  const { summary, details } = describe(draft, account);
  const yes = await api.confirm({
    title: TITLES[draft.kind],
    summary,
    content: draft.text,
    details,
  });
  if (!yes) return CANCELLED;
  const mediaIds: string[] = [];
  for (const image of draft.images) mediaIds.push(await uploadImage(ctx, account, image));
  const body: Record<string, unknown> = { status: draft.text, visibility: draft.visibility };
  if (draft.spoiler !== undefined) body["spoiler_text"] = draft.spoiler;
  if (draft.inReplyTo) body["in_reply_to_id"] = (draft.inReplyTo.reblog ?? draft.inReplyTo).id;
  if (mediaIds.length > 0) body["media_ids"] = mediaIds;
  const response = await call(ctx, account, "/api/v1/statuses", {
    method: "POST",
    json: body,
    headers: { "Idempotency-Key": ctx.deps.uuid() },
  });
  const posted = (await response.json()) as Status;
  return `Posted (${posted.visibility}): ${posted.url ?? posted.id} (id ${posted.id})`;
}

const visibilityProp = {
  type: "string",
  enum: [...VISIBILITIES],
  description: "public, unlisted, private (followers only) or direct (mentioned people only).",
};
const spoilerProp = { type: "string", description: "Content warning shown before the text." };
const imagesProp = {
  type: "array",
  maxItems: 4,
  description: "Up to 4 images from local absolute paths, each with optional alt text.",
  items: {
    type: "object",
    properties: { path: { type: "string" }, alt: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};

const hasHandle = (text: string, acct: string) =>
  new RegExp(`(^|\\s)@${acct.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w@])`, "i").test(text);

function post(ctx: Ctx): ExtensionTool {
  return defineTool(
    {
      name: "mastodon_post",
      description:
        "Posts one new status to the reader's Mastodon account. The reader confirms a card showing the exact text, visibility, content warning and images first; when they cancel, nothing is posted and the tool says so. One post per request.",
      properties: {
        text: { type: "string" },
        visibility: visibilityProp,
        spoiler_text: spoilerProp,
        in_reply_to_id: {
          type: "string",
          description: "Id of a status on the reader's server to reply to (prefer mastodon_reply).",
        },
        images: imagesProp,
      },
      required: ["text"],
    },
    async (args) => {
      const text = postText(args, "text");
      const account = await requireAccount(ctx);
      const images = await loadImages(ctx, args["images"]);
      const replyId = optStr(args, "in_reply_to_id");
      const inReplyTo =
        replyId === undefined
          ? undefined
          : await getJson<Status>(ctx, account, `/api/v1/statuses/${replyId}`);
      return await send(ctx, account, {
        kind: inReplyTo ? "reply" : "post",
        text,
        visibility: optEnum(
          args,
          "visibility",
          VISIBILITIES,
          inReplyTo ? (inReplyTo.visibility as Visibility) : "public",
        ),
        spoiler: optStr(args, "spoiler_text"),
        inReplyTo,
        recipient: undefined,
        images,
      });
    },
  );
}

/** The parent author and everyone it mentions, except the reader, each as `@acct`, not already in the text. */
function mentionsFor(parent: Status, me: string, text: string): string {
  const accts = [parent.account.acct, ...(parent.mentions ?? []).map((mention) => mention.acct)];
  const wanted = [...new Set(accts)].filter((acct) => acct !== me && !hasHandle(text, acct));
  return wanted.map((acct) => `@${acct}`).join(" ");
}

function reply(ctx: Ctx): ExtensionTool {
  return defineTool(
    {
      name: "mastodon_reply",
      description:
        "Replies to a status, given by URL (any server) or by id on the reader's server. The visibility defaults to the parent's, the content warning to the parent's, and the needed @mentions are put in front of the text. The reader confirms a card first; when they cancel, nothing is posted. One reply per request.",
      properties: {
        status: { type: "string", description: "The status to reply to: a URL, or an id." },
        text: { type: "string", description: "Your reply, without the leading @mentions." },
        visibility: visibilityProp,
        spoiler_text: spoilerProp,
        images: imagesProp,
      },
      required: ["status", "text"],
    },
    async (args: Args) => {
      const body = postText(args, "text");
      const account = await requireAccount(ctx);
      const id = await resolveStatusId(ctx, account, postText(args, "status"));
      const found = await getJson<Status>(ctx, account, `/api/v1/statuses/${id}`);
      const parent = found.reblog ?? found;
      const images = await loadImages(ctx, args["images"]);
      const prefix = mentionsFor(parent, account.acct, body);
      return await send(ctx, account, {
        kind: "reply",
        text: prefix === "" ? body : `${prefix} ${body}`,
        visibility: optEnum(args, "visibility", VISIBILITIES, parent.visibility as Visibility),
        spoiler: optStr(args, "spoiler_text") ?? (parent.spoiler_text?.trim() || undefined),
        inReplyTo: parent,
        recipient: undefined,
        images,
      });
    },
  );
}

function dm(ctx: Ctx): ExtensionTool {
  return defineTool(
    {
      name: "mastodon_dm",
      description:
        "Sends a direct message (visibility direct) to one account, @user@host. The reader confirms a card showing the recipient and the exact text first; when they cancel, nothing is sent. One message per request.",
      properties: {
        to: { type: "string", description: "The recipient: @user@host." },
        text: { type: "string", description: "The message, without the leading @mention." },
        spoiler_text: spoilerProp,
        images: imagesProp,
      },
      required: ["to", "text"],
    },
    async (args) => {
      const body = postText(args, "text");
      const to = postText(args, "to");
      if (/^(me|self)?$/i.test(to.replace(/^@/, "")))
        throw new UserError("Give the recipient as @user@host.");
      const account = await requireAccount(ctx);
      const recipient = await resolveAccount(ctx, account, to);
      const images = await loadImages(ctx, args["images"]);
      return await send(ctx, account, {
        kind: "dm",
        text: hasHandle(body, recipient.acct) ? body : `@${recipient.acct} ${body}`,
        visibility: "direct",
        spoiler: optStr(args, "spoiler_text"),
        inReplyTo: undefined,
        recipient,
        images,
      });
    },
  );
}

export function writeTools(ctx: Ctx): ExtensionTool[] {
  return [post(ctx), reply(ctx), dm(ctx)];
}

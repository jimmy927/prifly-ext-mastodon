/** The reads: they run at once and change nothing. */

import type { ExtensionTool } from "@prifly/extension-api";
import { getJson } from "./client";
import {
  DATA_NOTE,
  renderAccount,
  renderNotifications,
  renderStatus,
  renderStatuses,
  renderTag,
} from "./render";
import { resolveAccount, resolveStatusId } from "./resolve";
import { type Ctx, requireAccount } from "./store";
import { defineTool, optEnum, optInt, optStr, reqStr } from "./tool";
import type { MastodonNotification, SearchResults, Status, StatusContext } from "./types";

const paging = {
  limit: { type: "integer", minimum: 1, maximum: 40, description: "How many (default 20)." },
  max_id: { type: "string", description: "Only older than this id: the next page back." },
  since_id: { type: "string", description: "Only newer than this id." },
};

type Page = { limit: number; max_id: string | undefined; since_id: string | undefined };

function page(args: Record<string, unknown>): Page {
  return {
    limit: optInt(args, "limit", 20, 1, 40),
    max_id: optStr(args, "max_id"),
    since_id: optStr(args, "since_id"),
  };
}

const TIMELINES = ["home", "local", "federated"] as const;

function timeline(ctx: Ctx): ExtensionTool {
  return defineTool(
    {
      name: "mastodon_timeline",
      description:
        "Reads a page of the reader's Mastodon timeline: home, local (their server) or federated (everything their server knows). Page back with max_id from the last post of the previous page. Changes nothing.",
      properties: {
        timeline: { type: "string", enum: [...TIMELINES], description: "Default home." },
        ...paging,
      },
    },
    async (args) => {
      const which = optEnum(args, "timeline", TIMELINES, "home");
      const { limit, max_id, since_id } = page(args);
      const account = await requireAccount(ctx);
      const statuses = await getJson<Status[]>(
        ctx,
        account,
        which === "home" ? "/api/v1/timelines/home" : "/api/v1/timelines/public",
        { limit, max_id, since_id, local: which === "local" ? true : undefined },
      );
      if (statuses.length === 0) {
        return max_id === undefined
          ? `The ${which} timeline is empty.`
          : `The ${which} timeline has nothing older than ${max_id}.`;
      }
      return renderStatuses(statuses, `${which} timeline on ${new URL(account.server).host}`);
    },
  );
}

function notifications(ctx: Ctx): ExtensionTool {
  return defineTool(
    {
      name: "mastodon_notifications",
      description:
        "Reads a page of the reader's Mastodon notifications (mentions, boosts, favourites, follows). Page back with max_id. Changes nothing.",
      properties: paging,
    },
    async (args) => {
      const { limit, max_id, since_id } = page(args);
      const account = await requireAccount(ctx);
      const notes = await getJson<MastodonNotification[]>(ctx, account, "/api/v1/notifications", {
        limit,
        max_id,
        since_id,
      });
      if (notes.length === 0) return "There are no notifications.";
      return renderNotifications(notes);
    },
  );
}

function thread(ctx: Ctx): ExtensionTool {
  return defineTool(
    {
      name: "mastodon_thread",
      description:
        "Reads one status with its thread: the posts above it (ancestors) and the replies below (descendants). Give the status by URL (any server) or by id on the reader's server. Changes nothing.",
      properties: {
        status: { type: "string", description: "A status URL, or its id on the reader's server." },
      },
      required: ["status"],
    },
    async (args) => {
      const account = await requireAccount(ctx);
      const id = await resolveStatusId(ctx, account, reqStr(args, "status"));
      const status = await getJson<Status>(ctx, account, `/api/v1/statuses/${id}`);
      const context = await getJson<StatusContext>(ctx, account, `/api/v1/statuses/${id}/context`);
      const section = (title: string, list: Status[]) =>
        list.length === 0
          ? `### ${title}\n(none)`
          : `### ${title}\n\n${list.map(renderStatus).join("\n\n---\n\n")}`;
      return [
        DATA_NOTE,
        section("Earlier in the thread", context.ancestors),
        `### The status\n\n${renderStatus(status)}`,
        section("Replies", context.descendants),
      ].join("\n\n");
    },
  );
}

function profile(ctx: Ctx): ExtensionTool {
  return defineTool(
    {
      name: "mastodon_profile",
      description:
        'Reads an account and its recent posts. Give @user@host, an account id, or a profile URL; leave it empty (or "me") for the signed-in reader. Changes nothing.',
      properties: {
        account: {
          type: "string",
          description: "@user@host, id, profile URL, or empty for the reader.",
        },
        limit: paging.limit,
        max_id: paging.max_id,
      },
    },
    async (args) => {
      const { limit, max_id } = page(args);
      const signedIn = await requireAccount(ctx);
      const found = await resolveAccount(ctx, signedIn, optStr(args, "account") ?? "");
      const statuses = await getJson<Status[]>(
        ctx,
        signedIn,
        `/api/v1/accounts/${found.id}/statuses`,
        {
          limit,
          max_id,
        },
      );
      const body =
        statuses.length === 0
          ? "No posts to show."
          : renderStatuses(statuses, `Recent posts by @${found.acct}`);
      return `## Profile\n\n${renderAccount(found)}\n\n${body}`;
    },
  );
}

const SEARCH_TYPES = ["all", "accounts", "statuses", "hashtags"] as const;

function search(ctx: Ctx): ExtensionTool {
  return defineTool(
    {
      name: "mastodon_search",
      description: "Searches accounts, posts and hashtags on the reader's server. Changes nothing.",
      properties: {
        query: { type: "string" },
        type: { type: "string", enum: [...SEARCH_TYPES], description: "Default all." },
        limit: { type: "integer", minimum: 1, maximum: 40, description: "Per kind (default 10)." },
      },
      required: ["query"],
    },
    async (args) => {
      const q = reqStr(args, "query");
      const type = optEnum(args, "type", SEARCH_TYPES, "all");
      const account = await requireAccount(ctx);
      const found = await getJson<SearchResults>(ctx, account, "/api/v2/search", {
        q,
        type: type === "all" ? undefined : type,
        limit: optInt(args, "limit", 10, 1, 40),
      });
      const parts: string[] = [];
      if (found.accounts?.length) {
        parts.push(`## Accounts\n\n${found.accounts.map(renderAccount).join("\n\n")}`);
      }
      if (found.statuses?.length) parts.push(renderStatuses(found.statuses, "Posts", false));
      if (found.hashtags?.length)
        parts.push(`## Hashtags\n\n${found.hashtags.map(renderTag).join("\n")}`);
      return parts.length === 0 ? `Nothing found for "${q}".` : parts.join("\n\n");
    },
  );
}

export function readTools(ctx: Ctx): ExtensionTool[] {
  return [timeline(ctx), notifications(ctx), thread(ctx), profile(ctx), search(ctx)];
}

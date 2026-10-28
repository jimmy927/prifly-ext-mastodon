/** Turning what a reader typed (a URL, an id, @user@host) into the ids this server uses. */

import { getJson } from "./client";
import { UserError } from "./errors";
import type { Ctx } from "./store";
import type { Account, SearchResults, StoredAccount } from "./types";

const LOCAL_STATUS_PATHS = [
  /^\/@[^/]+\/(\d+)\/?$/,
  /^\/web\/statuses\/(\d+)\/?$/,
  /^\/statuses\/(\d+)\/?$/,
];

function parseUrl(text: string): URL | null {
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * A status's id on the signed-in server. A number is that id already; a URL on
 * the same server is read from its path; any other URL is resolved by the
 * server (`/api/v2/search?resolve=true`), which fetches it from its own server.
 */
export async function resolveStatusId(
  ctx: Ctx,
  account: StoredAccount,
  input: string,
): Promise<string> {
  const text = input.trim();
  if (/^\d+$/.test(text)) return text;
  const url = parseUrl(text);
  if (url === null) throw new UserError(`"${text}" is neither a status URL nor a numeric id.`);
  if (url.host === new URL(account.server).host) {
    for (const pattern of LOCAL_STATUS_PATHS) {
      const found = pattern.exec(url.pathname)?.[1];
      if (found) return found;
    }
  }
  const results = await getJson<SearchResults>(ctx, account, "/api/v2/search", {
    q: text,
    resolve: true,
    type: "statuses",
    limit: 1,
  });
  const id = results.statuses?.[0]?.id;
  if (id === undefined) {
    throw new UserError(
      `${new URL(account.server).host} could not find ${text}. It may be private, deleted, or on a server yours cannot reach.`,
    );
  }
  return id;
}

function acctFromInput(text: string): string | null {
  const url = parseUrl(text);
  if (url !== null) {
    const name = /^\/@([^/]+)\/?$/.exec(url.pathname)?.[1];
    return name === undefined ? null : `${name}@${url.host}`;
  }
  return text.replace(/^@/, "");
}

/** An account from "@user@host", "user", an id, a profile URL, or empty / "me" for the signed-in one. */
export async function resolveAccount(
  ctx: Ctx,
  account: StoredAccount,
  input: string,
): Promise<Account> {
  const text = input.trim();
  if (text === "" || text.toLowerCase() === "me") {
    return await getJson<Account>(ctx, account, "/api/v1/accounts/verify_credentials");
  }
  if (/^\d+$/.test(text)) {
    return await getJson<Account>(ctx, account, `/api/v1/accounts/${text}`);
  }
  const acct = acctFromInput(text);
  if (acct === null)
    throw new UserError(`"${text}" is not an @user@host, an account id or a profile URL.`);
  try {
    return await getJson<Account>(ctx, account, "/api/v1/accounts/lookup", { acct });
  } catch (error) {
    if (error instanceof UserError && error.status === 404) {
      throw new UserError(`No account @${acct} found on ${new URL(account.server).host}.`, 404);
    }
    throw error;
  }
}

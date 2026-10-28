/**
 * What the extension remembers, in `api.secrets` (sealed with the vault's
 * device key): the signed-in account with its token, and the OAuth app
 * registered on each server. Nothing goes to a file, and nothing here is
 * ever logged or returned to a session.
 */

import type { ExtensionApi, ExtensionSecretsApi } from "@prifly/extension-api";
import type { Deps } from "./deps";
import { NOT_SIGNED_IN, UserError } from "./errors";
import type { StoredAccount, StoredClient } from "./types";

export type Ctx = { api: () => ExtensionApi | null; deps: Deps };

const ACCOUNT = "account";
const clientKey = (host: string) => `client.${host}`;

function secrets(ctx: Ctx): ExtensionSecretsApi {
  const store = ctx.api()?.secrets;
  if (store === undefined) {
    throw new UserError(
      "This prifly has no secret store for extensions, so a Mastodon token cannot be kept safely. Update prifly.",
    );
  }
  return store;
}

function parse<T>(
  text: string | null,
  valid: (value: Record<string, unknown>) => boolean,
): T | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && valid(value as Record<string, unknown>)) {
      return value as T;
    }
  } catch {
    // A damaged entry reads as none: the reader signs in again.
  }
  return null;
}

const isText = (value: unknown) => typeof value === "string" && value !== "";

export async function loadAccount(ctx: Ctx): Promise<StoredAccount | null> {
  const store = ctx.api()?.secrets;
  if (store === undefined) return null;
  return parse<StoredAccount>(
    await store.get(ACCOUNT),
    (v) => isText(v["server"]) && isText(v["token"]) && isText(v["acct"]),
  );
}

export async function requireAccount(ctx: Ctx): Promise<StoredAccount> {
  const account = await loadAccount(ctx);
  if (account === null) throw new UserError(NOT_SIGNED_IN);
  return account;
}

export async function saveAccount(ctx: Ctx, account: StoredAccount): Promise<void> {
  await secrets(ctx).set(ACCOUNT, JSON.stringify(account));
  showStatus(ctx, account);
}

export async function clearAccount(ctx: Ctx): Promise<void> {
  await ctx.api()?.secrets?.set(ACCOUNT, null);
  showStatus(ctx, null);
}

export async function loadClient(ctx: Ctx, host: string): Promise<StoredClient | null> {
  const store = ctx.api()?.secrets;
  if (store === undefined) return null;
  return parse<StoredClient>(
    await store.get(clientKey(host)),
    (v) => isText(v["client_id"]) && isText(v["client_secret"]) && isText(v["redirect_uri"]),
  );
}

export async function saveClient(ctx: Ctx, host: string, client: StoredClient): Promise<void> {
  await secrets(ctx).set(clientKey(host), JSON.stringify(client));
}

/** The one status line: who is signed in where, or how to sign in. */
export function showStatus(ctx: Ctx, account: StoredAccount | null): void {
  const line =
    account === null
      ? "Not signed in: run mastodon_sign_in with your server"
      : `Signed in as @${account.acct} on ${new URL(account.server).host}`;
  ctx.api()?.status?.(line);
}

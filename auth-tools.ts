/**
 * Sign-in with Mastodon's official OAuth, on the reader's own server:
 * register an app (cached per server), send the reader's browser to
 * /oauth/authorize, catch the code on a loopback server bound to 127.0.0.1
 * (state checked, with a timeout), exchange it at /oauth/token, verify it,
 * and keep the token in `api.secrets` only.
 */

import type { ExtensionTool } from "@prifly/extension-api";
import { request } from "./client";
import type { CallbackServer } from "./deps";
import { UserError } from "./errors";
import { type Ctx, clearAccount, loadAccount, loadClient, saveAccount, saveClient } from "./store";
import { defineTool, reqStr } from "./tool";
import type { Account, StoredClient } from "./types";

export const SCOPES = "read write";

/** "mastodon.social", "@me@mastodon.social" or "https://mastodon.social/home" as the server's origin. */
export function serverOrigin(input: string): string {
  const text = input.trim().replace(/^@?[^@/\s]*@(?=[^@/\s]+$)/, "");
  const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.hostname === "" || (!url.hostname.includes(".") && !local)) {
    throw new UserError(`"${input}" is not a Mastodon server name (try mastodon.social).`);
  }
  return `${local ? url.protocol : "https:"}//${url.host}`;
}

async function registerApp(ctx: Ctx, server: string, redirectUri: string): Promise<StoredClient> {
  const host = new URL(server).host;
  const cached = await loadClient(ctx, host);
  if (cached !== null && cached.redirect_uri === redirectUri) return cached;
  const form = new URLSearchParams({
    client_name: "prifly",
    redirect_uris: redirectUri,
    scopes: SCOPES,
    website: "https://github.com/jimmy927/prifly-ext-mastodon",
  });
  const response = await request(ctx.deps, server, "/api/v1/apps", { method: "POST", form });
  const app = (await response.json()) as { client_id?: string; client_secret?: string };
  if (!app.client_id || !app.client_secret) {
    throw new UserError(`${host} did not return an app registration.`);
  }
  const client = {
    client_id: app.client_id,
    client_secret: app.client_secret,
    redirect_uri: redirectUri,
  };
  await saveClient(ctx, host, client);
  return client;
}

async function waitForCode(
  ctx: Ctx,
  callback: CallbackServer,
  authorizeUrl: string,
  state: string,
  host: string,
): Promise<string> {
  const waiting = callback.wait(state, ctx.deps.callbackTimeoutMs);
  if (!(await ctx.deps.openBrowser(authorizeUrl))) {
    throw new UserError(
      `Could not open your browser. Open this address yourself, approve prifly, and run mastodon_sign_in again:\n${authorizeUrl}`,
    );
  }
  const result = await waiting;
  if ("error" in result) {
    throw new UserError(
      `Sign-in to ${host} did not finish: ${result.error}. Run mastodon_sign_in to try again.`,
    );
  }
  return result.code;
}

async function exchange(
  ctx: Ctx,
  server: string,
  client: StoredClient,
  code: string,
): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: client.redirect_uri,
    scope: SCOPES,
  });
  const response = await request(ctx.deps, server, "/oauth/token", { method: "POST", form });
  const token = ((await response.json()) as { access_token?: string }).access_token;
  if (!token) throw new UserError(`${new URL(server).host} did not return a token.`);
  return token;
}

export async function signIn(ctx: Ctx, input: string): Promise<string> {
  const server = serverOrigin(input);
  const host = new URL(server).host;
  const cached = await loadClient(ctx, host);
  const preferred =
    cached === null ? undefined : Number(new URL(cached.redirect_uri).port) || undefined;
  const callback = await ctx.deps.listen(preferred);
  try {
    const client = await registerApp(ctx, server, callback.redirectUri);
    const state = ctx.deps.uuid();
    const authorize = new URL("/oauth/authorize", server);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: client.redirect_uri,
      scope: SCOPES,
      state,
    }).toString();
    const code = await waitForCode(ctx, callback, authorize.toString(), state, host);
    const token = await exchange(ctx, server, client, code);
    const me = await request(ctx.deps, server, "/api/v1/accounts/verify_credentials", { token });
    const acct = ((await me.json()) as Account).acct;
    await saveAccount(ctx, { server, token, acct });
    return `Signed in as @${acct} on ${host}. The token is kept in prifly's secret store.`;
  } finally {
    callback.close();
  }
}

export async function signOut(ctx: Ctx): Promise<string> {
  const account = await loadAccount(ctx);
  if (account === null) return "Not signed in to Mastodon; nothing to sign out of.";
  const host = new URL(account.server).host;
  const client = await loadClient(ctx, host);
  if (client !== null) {
    // Best effort: tell the server to drop the token. The local copy goes either way.
    const form = new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      token: account.token,
    });
    await request(ctx.deps, account.server, "/oauth/revoke", { method: "POST", form }).catch(
      () => undefined,
    );
  }
  await clearAccount(ctx);
  return `Signed out of @${account.acct} on ${host}. The saved token was removed.`;
}

export function authTools(ctx: Ctx): ExtensionTool[] {
  return [
    defineTool(
      {
        name: "mastodon_sign_in",
        description:
          "Signs the reader in to their Mastodon server: opens the server's approval page in their browser and waits (up to 3 minutes) for them to approve prifly. Give the server name, e.g. mastodon.social. Works with any instance.",
        properties: {
          server: { type: "string", description: "The reader's server, e.g. mastodon.social." },
        },
        required: ["server"],
      },
      async (args) => await signIn(ctx, reqStr(args, "server")),
    ),
    defineTool(
      {
        name: "mastodon_sign_out",
        description:
          "Signs out of Mastodon: asks the server to revoke the token and removes the saved copy.",
        properties: {},
      },
      async () => await signOut(ctx),
    ),
  ];
}

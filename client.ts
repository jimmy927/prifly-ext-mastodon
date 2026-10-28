/**
 * Every request to a Mastodon server goes through `request`: it names the
 * server when it cannot be reached, keeps to the server's rate limit
 * (`X-RateLimit-*`), and never retries. `call` adds the signed-in token and
 * turns a 401 into a cleared token.
 */

import type { Deps } from "./deps";
import { UserError } from "./errors";
import { type Ctx, clearAccount } from "./store";
import type { StoredAccount } from "./types";

/** At or below this many calls left, further calls wait for the reset. */
export const LOW_REMAINING = 5;

export type RequestOptions = {
  method?: "GET" | "POST";
  query?: Record<string, string | number | boolean | undefined>;
  /** A JSON body. */
  json?: unknown;
  /** A form body: URLSearchParams or multipart FormData. */
  form?: URLSearchParams | FormData;
  headers?: Record<string, string>;
  token?: string;
};

export function formatTime(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function checkRate(deps: Deps, host: string): void {
  const state = deps.rate.get(host);
  if (state === undefined) return;
  if (state.reset <= deps.now()) {
    deps.rate.delete(host);
    return;
  }
  if (state.remaining <= LOW_REMAINING) {
    throw new UserError(
      `Not calling ${host}: its rate limit is nearly used (${state.remaining} left). Calls are paused until ${formatTime(state.reset)}.`,
    );
  }
}

function learnRate(deps: Deps, host: string, response: Response): number | null {
  const remaining = Number(response.headers.get("X-RateLimit-Remaining"));
  const resetHeader = response.headers.get("X-RateLimit-Reset");
  const parsed = resetHeader === null ? Number.NaN : Date.parse(resetHeader);
  if (response.status === 429) {
    const reset = Number.isNaN(parsed) ? deps.now() + 300_000 : parsed;
    deps.rate.set(host, { remaining: 0, reset });
    return reset;
  }
  if (response.headers.get("X-RateLimit-Remaining") !== null && !Number.isNaN(parsed)) {
    deps.rate.set(host, { remaining, reset: parsed });
  }
  return null;
}

async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: string; error_description?: string };
    return body.error_description ?? body.error ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

function urlFor(server: string, path: string, query: RequestOptions["query"]): string {
  const url = new URL(path, server);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** One call; resolves with a 2xx response, throws a `UserError` otherwise. */
export async function request(
  deps: Deps,
  server: string,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const host = new URL(server).host;
  checkRate(deps, host);
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  if (options.token !== undefined) headers["Authorization"] = `Bearer ${options.token}`;
  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.json);
  } else if (options.form !== undefined) {
    init.body = options.form;
  }
  let response: Response;
  try {
    response = await deps.fetch(urlFor(server, path, options.query), init);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new UserError(
      `Could not reach ${host} (${why}). Check the server name and your connection.`,
    );
  }
  const limitedUntil = learnRate(deps, host, response);
  if (limitedUntil !== null) {
    throw new UserError(
      `${host} says you are rate limited (429). Nothing was retried; try again after ${formatTime(limitedUntil)}.`,
      429,
    );
  }
  if (!response.ok) {
    const why = await errorText(response);
    throw new UserError(
      `${host} answered ${response.status}${why === "" ? "" : `: ${why}`}`,
      response.status,
    );
  }
  return response;
}

/** `request` with the signed-in token; a 401 clears it and asks the reader to sign in again. */
export async function call(
  ctx: Ctx,
  account: StoredAccount,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  try {
    return await request(ctx.deps, account.server, path, { ...options, token: account.token });
  } catch (error) {
    if (error instanceof UserError && error.status === 401) {
      await clearAccount(ctx);
      throw new UserError(
        `${new URL(account.server).host} no longer accepts the saved sign-in (401, revoked or expired). The saved token was cleared. Run mastodon_sign_in with the server to sign in again.`,
        401,
      );
    }
    throw error;
  }
}

export async function getJson<T>(
  ctx: Ctx,
  account: StoredAccount,
  path: string,
  query?: RequestOptions["query"],
): Promise<T> {
  const options: RequestOptions = query === undefined ? {} : { query };
  return (await (await call(ctx, account, path, options)).json()) as T;
}

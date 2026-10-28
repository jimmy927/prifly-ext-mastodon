/**
 * Everything a test needs and nothing real: a fake Mastodon server (a router
 * behind `deps.fetch`), a fake browser, a fake loopback callback, a fake disk,
 * an in-memory `api.secrets` and the template's fake `api`.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { type CallbackResult, type CallbackServer, type Deps, handleCallback } from "../deps";
import { activateWith } from "../index";
import type { Status, StoredAccount } from "../types";
import { type FakeApi, fakeApi } from "./fake-api";

export const SERVER = "https://masto.test";
export const TOKEN = "tok-secret-123";

export type Seen = {
  method: string;
  url: URL;
  headers: Headers;
  body: string | FormData | URLSearchParams | null;
};

export type Handler = Response | ((seen: Seen) => Response | Promise<Response>);

export type World = {
  fake: FakeApi;
  deps: Deps;
  /** Every request the fake server got, in order. */
  seen: Seen[];
  /** `"GET /api/v1/x"` -> its answer; set before the call. */
  routes: Map<string, Handler>;
  secrets: Map<string, string>;
  /** Every URL the fake browser was asked to open. */
  browser: string[];
  sleeps: number[];
  /** What the fake browser's redirect delivers, given the state in the authorize URL. */
  callback: { query: (state: string) => string; ports: (number | undefined)[]; closed: number };
  files: Map<string, { bytes: Uint8Array; type: string }>;
  clock: { now: number };
  signedIn: () => void;
  requests: (key: string) => Seen[];
};

export const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);

export function account(overrides: Record<string, unknown> = {}) {
  return {
    id: "7",
    username: "ada",
    acct: "ada@other.test",
    display_name: "Ada L",
    url: "https://other.test/@ada",
    note: "<p>Maths &amp; engines</p>",
    followers_count: 10,
    following_count: 5,
    statuses_count: 99,
    created_at: "2020-01-02T03:04:05.000Z",
    ...overrides,
  };
}

export function status(id: string, overrides: Partial<Status> = {}): Status {
  return {
    id,
    url: `${SERVER}/@ada/${id}`,
    created_at: "2026-10-28T12:34:56.000Z",
    account: account() as Status["account"],
    content: '<p>Hello <a href="https://x.test">world</a> &amp; friends<br>second line</p>',
    spoiler_text: "",
    visibility: "public",
    sensitive: false,
    in_reply_to_id: null,
    reblog: null,
    media_attachments: [],
    mentions: [],
    replies_count: 1,
    reblogs_count: 2,
    favourites_count: 3,
    ...overrides,
  };
}

export async function world(
  options: { confirm?: boolean; signedIn?: boolean } = {},
): Promise<World> {
  const fake = fakeApi(options.confirm === undefined ? {} : { confirm: options.confirm });
  const secrets = new Map<string, string>();
  fake.api.secrets = {
    get: async (key) => secrets.get(key) ?? null,
    set: async (key, value) =>
      void (value === null ? secrets.delete(key) : secrets.set(key, value)),
    keys: async () => [...secrets.keys()],
  };
  const seen: Seen[] = [];
  const routes = new Map<string, Handler>();
  const browser: string[] = [];
  const sleeps: number[] = [];
  const files = new Map<string, { bytes: Uint8Array; type: string }>();
  const clock = { now: Date.parse("2026-10-28T12:00:00.000Z") };
  const callback: World["callback"] = {
    query: (state) => `code=auth-code&state=${state}`,
    ports: [],
    closed: 0,
  };

  const listen = async (port?: number): Promise<CallbackServer> => {
    callback.ports.push(port);
    return {
      redirectUri: `http://127.0.0.1:${port ?? 41234}/callback`,
      wait: async (state): Promise<CallbackResult> => {
        // The browser's redirect, answered by the real request handler.
        const answer = handleCallback(`/callback?${callback.query(state)}`, state);
        return answer.result ?? { error: "state mismatch" };
      },
      close: () => {
        callback.closed += 1;
      },
    };
  };

  const deps: Deps = {
    fetch: async (url, init) => {
      const parsed = new URL(url);
      const method = init?.method ?? "GET";
      const record: Seen = {
        method,
        url: parsed,
        headers: new Headers(init?.headers),
        body: (init?.body as Seen["body"]) ?? null,
      };
      seen.push(record);
      const handler = routes.get(`${method} ${parsed.pathname}`);
      if (handler === undefined) return json({ error: "no fake route" }, { status: 404 });
      const answer: unknown =
        typeof handler === "function" ? await handler(record) : handler.clone();
      // Bun's Response and undici's differ only in their typings.
      return answer as Response;
    },
    openBrowser: async (url) => {
      browser.push(url);
      return true;
    },
    listen,
    readFile: async (path) => {
      const file = files.get(path);
      if (file === undefined) throw new Error(`fake disk has no ${path}`);
      return { ...file, name: path.split(/[\\/]/).pop() ?? path };
    },
    sleep: async (ms) => void sleeps.push(ms),
    now: () => clock.now,
    uuid: () => "fixed-uuid",
    rate: new Map(),
    callbackTimeoutMs: 1000,
    mediaPollMs: 10,
    mediaPollMax: 5,
  };

  const signedIn = () => {
    const stored: StoredAccount = { server: SERVER, token: TOKEN, acct: "me" };
    secrets.set("account", JSON.stringify(stored));
  };
  if (options.signedIn) signedIn();
  activateWith(fake.api as ExtensionApi, deps);
  // Let activate's first look at the stored account finish.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const requests = (key: string) =>
    seen.filter((each) => `${each.method} ${each.url.pathname}` === key);
  return {
    fake,
    deps,
    seen,
    routes,
    secrets,
    browser,
    sleeps,
    callback,
    files,
    clock,
    signedIn,
    requests,
  };
}

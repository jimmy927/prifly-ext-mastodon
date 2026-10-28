/**
 * Everything the extension touches outside itself, behind seams a test
 * replaces: the network (`fetch`), the reader's browser (`openBrowser`), the
 * loopback server that catches the OAuth redirect (`listen`) and the disk
 * (`readFile`). `defaultDeps` is the real thing.
 */

import { createServer } from "node:http";
import { basename } from "node:path";
import type { ExtensionApi } from "@prifly/extension-api";
import { UserError } from "./errors";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** What the browser was redirected back with: a code, or why there is none. */
export type CallbackResult = { code: string } | { error: string };

export type CallbackServer = {
  /** `http://127.0.0.1:<port>/callback`: what the app is registered with. */
  redirectUri: string;
  /** Resolves with the first redirect that carries `state`, or `{ error }` after `timeoutMs`. */
  wait(state: string, timeoutMs: number): Promise<CallbackResult>;
  close(): void;
};

export type LoadedFile = { bytes: Uint8Array; type: string; name: string };

/** The rate limit a server last announced: calls left, and when they come back (epoch ms). */
export type RateState = { remaining: number; reset: number };

export type Deps = {
  fetch: FetchLike;
  /** True when a browser was opened on `url`. */
  openBrowser: (url: string) => Promise<boolean>;
  /** Starts a loopback server, on `preferredPort` if it is free. */
  listen: (preferredPort?: number) => Promise<CallbackServer>;
  readFile: (path: string) => Promise<LoadedFile>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  uuid: () => string;
  rate: Map<string, RateState>;
  callbackTimeoutMs: number;
  mediaPollMs: number;
  mediaPollMax: number;
};

/** What the loopback server answers one request, and what it learnt from it. */
export function handleCallback(
  requestUrl: string,
  expectedState: string,
): { status: number; body: string; result: CallbackResult | null } {
  const url = new URL(requestUrl, "http://127.0.0.1");
  if (url.pathname !== "/callback") return { status: 404, body: "Not found", result: null };
  if (url.searchParams.get("state") !== expectedState) {
    return { status: 400, body: "This sign-in did not start here. Close this tab.", result: null };
  }
  const error = url.searchParams.get("error");
  if (error !== null) {
    return {
      status: 200,
      body: `Sign-in was not completed (${error}). You can close this tab.`,
      result: { error },
    };
  }
  const code = url.searchParams.get("code");
  if (code === null || code === "")
    return { status: 400, body: "No code in the redirect.", result: null };
  return {
    status: 200,
    body: "Signed in. You can close this tab and go back to prifly.",
    result: { code },
  };
}

function listenOn(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** A real HTTP server bound to 127.0.0.1 only. */
export async function listenLoopback(preferredPort?: number): Promise<CallbackServer> {
  let expected: string | null = null;
  let deliver: ((result: CallbackResult) => void) | null = null;
  const server = createServer((req, res) => {
    const answer =
      expected === null
        ? { status: 503, body: "Not waiting for a sign-in.", result: null }
        : handleCallback(req.url ?? "/", expected);
    res.writeHead(answer.status, { "content-type": "text/plain; charset=utf-8" });
    res.end(answer.body);
    if (answer.result !== null) deliver?.(answer.result);
  });
  try {
    await listenOn(server, preferredPort ?? 0);
  } catch {
    // The preferred port is taken: any free one will do, the app is registered again for it.
    await listenOn(server, 0);
  }
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    wait: (state, timeoutMs) =>
      new Promise((resolve) => {
        expected = state;
        const timer = setTimeout(
          () => resolve({ error: "timed out waiting for the browser" }),
          timeoutMs,
        );
        deliver = (result) => {
          clearTimeout(timer);
          resolve(result);
        };
      }),
    close: () => void server.close(),
  };
}

async function readLocalFile(path: string): Promise<LoadedFile> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new UserError(`No such file: ${path}`);
  const type = file.type.split(";")[0] ?? "";
  return { bytes: new Uint8Array(await file.arrayBuffer()), type, name: basename(path) };
}

export function defaultDeps(api: ExtensionApi): Deps {
  return {
    fetch: (url, init) => fetch(url, init),
    openBrowser: async (url) => (await api.openUrl?.(url)) === true,
    listen: listenLoopback,
    readFile: readLocalFile,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
    rate: new Map(),
    callbackTimeoutMs: 180_000,
    mediaPollMs: 1_000,
    mediaPollMax: 60,
  };
}

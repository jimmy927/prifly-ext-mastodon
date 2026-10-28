import { expect, test } from "bun:test";
import { serverOrigin } from "../auth-tools";
import { handleCallback } from "../deps";
import { json, SERVER, TOKEN, type World, world } from "./world";

function mastodon(w: World) {
  w.routes.set("POST /api/v1/apps", json({ client_id: "cid", client_secret: "csecret" }));
  w.routes.set("POST /oauth/token", json({ access_token: TOKEN, token_type: "Bearer" }));
  w.routes.set("GET /api/v1/accounts/verify_credentials", json({ id: "1", acct: "me" }));
  w.routes.set("POST /oauth/revoke", json({}));
}

const form = (body: unknown) => Object.fromEntries(new URLSearchParams(String(body)));

test("sign in end to end: app, browser, loopback callback, token, verify, secrets", async () => {
  const w = await world();
  mastodon(w);
  const answer = await w.fake.callTool("mastodon_sign_in", { server: "masto.test" });
  expect(answer).toBe(
    "Signed in as @me on masto.test. The token is kept in prifly's secret store.",
  );

  const app = form(w.requests("POST /api/v1/apps")[0]?.body);
  expect(app["redirect_uris"]).toBe("http://127.0.0.1:41234/callback");
  expect(app["scopes"]).toBe("read write");

  const opened = new URL(w.browser[0] ?? "");
  expect(opened.origin + opened.pathname).toBe(`${SERVER}/oauth/authorize`);
  expect(opened.searchParams.get("client_id")).toBe("cid");
  expect(opened.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:41234/callback");
  expect(opened.searchParams.get("response_type")).toBe("code");
  expect(opened.searchParams.get("state")).toBe("fixed-uuid");

  const exchange = form(w.requests("POST /oauth/token")[0]?.body);
  expect(exchange["code"]).toBe("auth-code");
  expect(exchange["grant_type"]).toBe("authorization_code");
  expect(exchange["client_secret"]).toBe("csecret");

  const verify = w.requests("GET /api/v1/accounts/verify_credentials")[0];
  expect(verify?.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);

  expect(JSON.parse(w.secrets.get("account") ?? "{}")).toEqual({
    server: SERVER,
    token: TOKEN,
    acct: "me",
  });
  expect(w.fake.statuses.at(-1)).toBe("Signed in as @me on masto.test");
  expect(w.callback.closed).toBe(1);
  // The token reaches nothing but the secret store.
  expect(JSON.stringify([answer, w.fake.statuses, w.fake.logs, w.fake.notices])).not.toContain(
    TOKEN,
  );
});

test("the registered app is cached per server and reused for the same redirect", async () => {
  const w = await world();
  mastodon(w);
  await w.fake.callTool("mastodon_sign_in", { server: "https://masto.test/" });
  await w.fake.callTool("mastodon_sign_in", { server: "masto.test" });
  expect(w.requests("POST /api/v1/apps")).toHaveLength(1);
  // The second run asked for the cached redirect's port.
  expect(w.callback.ports).toEqual([undefined, 41234]);
});

test("a different loopback port registers the app again", async () => {
  const w = await world();
  mastodon(w);
  w.secrets.set(
    "client.masto.test",
    JSON.stringify({
      client_id: "old",
      client_secret: "old",
      redirect_uri: "http://127.0.0.1:5555/callback",
    }),
  );
  w.deps.listen = async () => ({
    redirectUri: "http://127.0.0.1:6666/callback",
    wait: async () => ({ code: "c" }),
    close: () => undefined,
  });
  await w.fake.callTool("mastodon_sign_in", { server: "masto.test" });
  expect(w.requests("POST /api/v1/apps")).toHaveLength(1);
});

test("a browser that cannot open gives the address and stores nothing", async () => {
  const w = await world();
  mastodon(w);
  w.deps.openBrowser = async () => false;
  const answer = await w.fake.callTool("mastodon_sign_in", { server: "masto.test" });
  expect(answer).toContain("Could not open your browser");
  expect(answer).toContain(`${SERVER}/oauth/authorize?`);
  expect(w.secrets.has("account")).toBe(false);
  expect(w.callback.closed).toBe(1);
});

test("a redirect with an error or the wrong state signs nothing in", async () => {
  const w = await world();
  mastodon(w);
  w.callback.query = () => "error=access_denied&state=fixed-uuid";
  expect(await w.fake.callTool("mastodon_sign_in", { server: "masto.test" })).toContain(
    "access_denied",
  );
  w.callback.query = () => "code=stolen&state=someone-else";
  expect(await w.fake.callTool("mastodon_sign_in", { server: "masto.test" })).toContain(
    "timed out waiting for the browser",
  );
  expect(w.requests("POST /oauth/token")).toHaveLength(0);
  expect(w.secrets.has("account")).toBe(false);
});

test("sign in to an unreachable server names it", async () => {
  const w = await world();
  w.routes.set("POST /api/v1/apps", () => {
    throw new TypeError("getaddrinfo ENOTFOUND nowhere.invalid");
  });
  const answer = await w.fake.callTool("mastodon_sign_in", { server: "nowhere.invalid" });
  expect(answer).toContain("Could not reach nowhere.invalid");
  expect(w.browser).toEqual([]);
});

test("a token the server will not verify is not kept", async () => {
  const w = await world();
  mastodon(w);
  w.routes.set(
    "GET /api/v1/accounts/verify_credentials",
    json({ error: "bad token" }, { status: 401 }),
  );
  const answer = await w.fake.callTool("mastodon_sign_in", { server: "masto.test" });
  expect(answer).toContain("401");
  expect(w.secrets.has("account")).toBe(false);
});

test("sign out revokes the token and removes it", async () => {
  const w = await world();
  mastodon(w);
  await w.fake.callTool("mastodon_sign_in", { server: "masto.test" });
  const answer = await w.fake.callTool("mastodon_sign_out", {});
  expect(answer).toContain("Signed out of @me on masto.test");
  expect(form(w.requests("POST /oauth/revoke")[0]?.body)["token"]).toBe(TOKEN);
  expect(w.secrets.has("account")).toBe(false);
  expect(w.fake.statuses.at(-1)).toContain("Not signed in");
  expect(await w.fake.callTool("mastodon_sign_out", {})).toContain("nothing to sign out of");
});

test("the loopback handler checks the state and the path", () => {
  expect(handleCallback("/callback?code=abc&state=s1", "s1").result).toEqual({ code: "abc" });
  expect(handleCallback("/callback?code=abc&state=other", "s1")).toMatchObject({
    status: 400,
    result: null,
  });
  expect(handleCallback("/callback?state=s1", "s1")).toMatchObject({ status: 400, result: null });
  expect(handleCallback("/other?code=abc&state=s1", "s1")).toMatchObject({
    status: 404,
    result: null,
  });
  expect(handleCallback("/callback?error=access_denied&state=s1", "s1").result).toEqual({
    error: "access_denied",
  });
});

test("server names are read from what the reader types", () => {
  expect(serverOrigin("mastodon.social")).toBe("https://mastodon.social");
  expect(serverOrigin(" https://Mastodon.social/home ")).toBe("https://mastodon.social");
  expect(serverOrigin("@ada@fosstodon.org")).toBe("https://fosstodon.org");
  expect(() => serverOrigin("nonsense")).toThrow();
});

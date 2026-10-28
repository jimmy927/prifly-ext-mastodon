import { expect, test } from "bun:test";
import { json, status, world } from "./world";

test("a 401 clears the stored token and asks to sign in again", async () => {
  const w = await world({ signedIn: true });
  w.routes.set(
    "GET /api/v1/timelines/home",
    json({ error: "The access token was revoked" }, { status: 401 }),
  );
  const out = await w.fake.callTool("mastodon_timeline", {});
  expect(out).toContain("no longer accepts the saved sign-in");
  expect(out).toContain("cleared");
  expect(out).toContain("mastodon_sign_in");
  expect(w.secrets.has("account")).toBe(false);
  expect(w.fake.statuses.at(-1)).toContain("Not signed in");
  // The next read does not even try the network.
  const count = w.seen.length;
  expect(await w.fake.callTool("mastodon_timeline", {})).toContain("Run mastodon_sign_in");
  expect(w.seen).toHaveLength(count);
});

test("a 429 reports the reset time and is never retried", async () => {
  const w = await world({ signedIn: true });
  w.routes.set(
    "GET /api/v1/timelines/home",
    json(
      { error: "Too many requests" },
      { status: 429, headers: { "X-RateLimit-Reset": "2026-10-28T12:03:00.000Z" } },
    ),
  );
  const out = await w.fake.callTool("mastodon_timeline", {});
  expect(out).toContain("rate limited (429)");
  expect(out).toContain("try again after 2026-10-28 12:03 UTC");
  expect(w.requests("GET /api/v1/timelines/home")).toHaveLength(1);
  // Until the reset, further calls are refused without touching the server.
  const again = await w.fake.callTool("mastodon_notifications", {});
  expect(again).toContain("paused until 2026-10-28 12:03 UTC");
  expect(w.seen).toHaveLength(1);
  // After it, calls go through again.
  w.clock.now = Date.parse("2026-10-28T12:03:01.000Z");
  w.routes.set("GET /api/v1/notifications", json([]));
  expect(await w.fake.callTool("mastodon_notifications", {})).toBe("There are no notifications.");
});

test("a low X-RateLimit-Remaining refuses further calls until Reset", async () => {
  const w = await world({ signedIn: true });
  w.routes.set(
    "GET /api/v1/timelines/home",
    json([status("1")], {
      headers: { "X-RateLimit-Remaining": "3", "X-RateLimit-Reset": "2026-10-28T12:05:00.000Z" },
    }),
  );
  expect(await w.fake.callTool("mastodon_timeline", {})).toContain("Hello world");
  const out = await w.fake.callTool("mastodon_timeline", {});
  expect(out).toContain("rate limit is nearly used (3 left)");
  expect(out).toContain("paused until 2026-10-28 12:05 UTC");
  expect(w.seen).toHaveLength(1);
  w.clock.now = Date.parse("2026-10-28T12:05:00.000Z");
  expect(await w.fake.callTool("mastodon_timeline", {})).toContain("Hello world");
  expect(w.seen).toHaveLength(2);
});

test("plenty of calls left does not hold anything back", async () => {
  const w = await world({ signedIn: true });
  w.routes.set(
    "GET /api/v1/timelines/home",
    json([status("1")], {
      headers: { "X-RateLimit-Remaining": "250", "X-RateLimit-Reset": "2026-10-28T12:05:00.000Z" },
    }),
  );
  await w.fake.callTool("mastodon_timeline", {});
  await w.fake.callTool("mastodon_timeline", {});
  expect(w.seen).toHaveLength(2);
});

test("an unreachable server is named", async () => {
  const w = await world({ signedIn: true });
  w.routes.set("GET /api/v1/timelines/home", () => {
    throw new TypeError("getaddrinfo ENOTFOUND masto.test");
  });
  const out = await w.fake.callTool("mastodon_timeline", {});
  expect(out).toContain("Could not reach masto.test");
  expect(out).toContain("ENOTFOUND");
  // A network failure is not a revoked token: the sign-in stays.
  expect(w.secrets.has("account")).toBe(true);
  expect(w.requests("GET /api/v1/timelines/home")).toHaveLength(1);
});

test("a server error is reported with its status and message", async () => {
  const w = await world({ signedIn: true });
  w.routes.set("GET /api/v1/timelines/home", json({ error: "Upstream broke" }, { status: 503 }));
  expect(await w.fake.callTool("mastodon_timeline", {})).toBe(
    "masto.test answered 503: Upstream broke",
  );
});

test("a 401 while posting clears the token and posts nothing more", async () => {
  const w = await world({ signedIn: true });
  w.routes.set("POST /api/v1/statuses", json({ error: "revoked" }, { status: 401 }));
  const out = await w.fake.callTool("mastodon_post", { text: "hi" });
  expect(out).toContain("sign in again");
  expect(w.secrets.has("account")).toBe(false);
  expect(w.requests("POST /api/v1/statuses")).toHaveLength(1);
});

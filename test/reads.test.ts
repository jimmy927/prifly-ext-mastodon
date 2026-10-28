import { expect, test } from "bun:test";
import { account, json, status, world } from "./world";

const READS: [string, Record<string, unknown>][] = [
  ["mastodon_timeline", {}],
  ["mastodon_notifications", {}],
  ["mastodon_thread", { status: "1" }],
  ["mastodon_profile", {}],
  ["mastodon_search", { query: "x" }],
];

test("every read says to sign in when not signed in, and calls nothing", async () => {
  const w = await world();
  for (const [name, args] of READS) {
    expect(await w.fake.callTool(name, args)).toContain("Run mastodon_sign_in");
  }
  expect(w.seen).toEqual([]);
});

test("the status line shows the signed-in account and server", async () => {
  expect((await world()).fake.statuses.at(-1)).toBe(
    "Not signed in: run mastodon_sign_in with your server",
  );
  expect((await world({ signedIn: true })).fake.statuses.at(-1)).toBe(
    "Signed in as @me on masto.test",
  );
});

test("the home timeline renders author, time, url, plain text, CW, media and counts", async () => {
  const w = await world();
  w.signedIn();
  w.routes.set(
    "GET /api/v1/timelines/home",
    json([
      status("101", {
        spoiler_text: "food talk",
        media_attachments: [
          { id: "m", type: "image", url: "https://m.test/a.png", description: "a cat" },
        ],
      }),
      status("100", {
        reblog: status("55", { account: account({ acct: "bob", display_name: "" }) as never }),
      }),
    ]),
  );
  const out = await w.fake.callTool("mastodon_timeline", { limit: 2 });
  expect(out).toContain("**Ada L (@ada@other.test)** · 2026-10-28 12:34 UTC · public");
  expect(out).toContain(`${"https://masto.test"}/@ada/101 · id 101`);
  expect(out).toContain("> Hello world & friends\n> second line");
  expect(out).not.toContain("<p>");
  expect(out).toContain("Content warning: food talk");
  expect(out).toContain('Media: image "a cat" https://m.test/a.png');
  expect(out).toContain("replies 1 · boosts 2 · favourites 3");
  expect(out).toContain("Boosted by Ada L (@ada@other.test)");
  expect(out).toContain("**@bob**");
  expect(out).toContain("Next page: pass max_id=100");
  const sent = w.requests("GET /api/v1/timelines/home")[0];
  expect(sent?.url.searchParams.get("limit")).toBe("2");
  expect(sent?.headers.get("Authorization")).toBe("Bearer tok-secret-123");
});

test("local and federated use the public timeline, paged with max_id and since_id", async () => {
  const w = await world();
  w.signedIn();
  w.routes.set("GET /api/v1/timelines/public", json([status("9")]));
  await w.fake.callTool("mastodon_timeline", { timeline: "local", max_id: "50" });
  await w.fake.callTool("mastodon_timeline", { timeline: "federated", since_id: "3" });
  const [local, federated] = w.requests("GET /api/v1/timelines/public");
  expect(local?.url.searchParams.get("local")).toBe("true");
  expect(local?.url.searchParams.get("max_id")).toBe("50");
  expect(federated?.url.searchParams.get("local")).toBeNull();
  expect(federated?.url.searchParams.get("since_id")).toBe("3");
});

test("an empty timeline and no notifications are said plainly", async () => {
  const w = await world();
  w.signedIn();
  w.routes.set("GET /api/v1/timelines/home", json([]));
  w.routes.set("GET /api/v1/notifications", json([]));
  expect(await w.fake.callTool("mastodon_timeline", {})).toBe("The home timeline is empty.");
  expect(await w.fake.callTool("mastodon_notifications", {})).toBe("There are no notifications.");
});

test("notifications render who did what, with the post", async () => {
  const w = await world();
  w.signedIn();
  w.routes.set(
    "GET /api/v1/notifications",
    json([
      {
        id: "n2",
        type: "favourite",
        created_at: "2026-10-28T10:00:00Z",
        account: account(),
        status: status("5"),
      },
      {
        id: "n1",
        type: "follow",
        created_at: "2026-10-27T10:00:00Z",
        account: account({ acct: "cy", display_name: "" }),
      },
    ]),
  );
  const out = await w.fake.callTool("mastodon_notifications", { max_id: "n9" });
  expect(out).toContain(
    "**Ada L (@ada@other.test)** favourited your post · 2026-10-28 10:00 UTC · notification id n2",
  );
  expect(out).toContain("> Hello world");
  expect(out).toContain("**@cy** followed you");
  expect(out).toContain("Next page: pass max_id=n1");
  expect(w.requests("GET /api/v1/notifications")[0]?.url.searchParams.get("max_id")).toBe("n9");
});

test("a thread from another server is resolved through search, then read with its context", async () => {
  const w = await world();
  w.signedIn();
  w.routes.set(
    "GET /api/v2/search",
    json({ statuses: [status("777")], accounts: [], hashtags: [] }),
  );
  w.routes.set("GET /api/v1/statuses/777", json(status("777")));
  w.routes.set(
    "GET /api/v1/statuses/777/context",
    json({
      ancestors: [status("700", { content: "<p>root</p>" })],
      descendants: [status("800", { content: "<p>a reply</p>", in_reply_to_id: "777" })],
    }),
  );
  const out = await w.fake.callTool("mastodon_thread", { status: "https://far.test/@zed/123456" });
  const search = w.requests("GET /api/v2/search")[0];
  expect(search?.url.searchParams.get("resolve")).toBe("true");
  expect(search?.url.searchParams.get("q")).toBe("https://far.test/@zed/123456");
  expect(out.indexOf("> root")).toBeLessThan(out.indexOf("The status"));
  expect(out.indexOf("The status")).toBeLessThan(out.indexOf("> a reply"));
  expect(out).toContain("Reply to id 777");
});

test("a thread on the reader's own server needs no search", async () => {
  const w = await world();
  w.signedIn();
  w.routes.set("GET /api/v1/statuses/42", json(status("42")));
  w.routes.set("GET /api/v1/statuses/42/context", json({ ancestors: [], descendants: [] }));
  const out = await w.fake.callTool("mastodon_thread", { status: "https://masto.test/@ada/42" });
  expect(w.requests("GET /api/v2/search")).toHaveLength(0);
  expect(out).toContain("Earlier in the thread\n(none)");
  expect(out).toContain("Replies\n(none)");
});

test("a status that cannot be resolved is said so", async () => {
  const w = await world();
  w.signedIn();
  w.routes.set("GET /api/v2/search", json({ statuses: [] }));
  expect(await w.fake.callTool("mastodon_thread", { status: "https://far.test/@z/1" })).toContain(
    "could not find",
  );
  expect(await w.fake.callTool("mastodon_thread", { status: "banana" })).toContain(
    "neither a status URL",
  );
});

test("a profile by @user@host shows the account and recent posts", async () => {
  const w = await world();
  w.signedIn();
  w.routes.set("GET /api/v1/accounts/lookup", json(account()));
  w.routes.set("GET /api/v1/accounts/7/statuses", json([status("3")]));
  const out = await w.fake.callTool("mastodon_profile", { account: "@ada@other.test" });
  expect(w.requests("GET /api/v1/accounts/lookup")[0]?.url.searchParams.get("acct")).toBe(
    "ada@other.test",
  );
  expect(out).toContain("**Ada L (@ada@other.test)**");
  expect(out).toContain("followers 10 · following 5 · posts 99 · joined 2020-01-02 03:04 UTC");
  expect(out).toContain("> Maths & engines");
  expect(out).toContain("Recent posts by @ada@other.test");
  expect(out).toContain("> Hello world");
});

test("a profile with no account is the signed-in reader's, and an unknown one is said so", async () => {
  const w = await world();
  w.signedIn();
  w.routes.set("GET /api/v1/accounts/verify_credentials", json(account({ id: "1", acct: "me" })));
  w.routes.set("GET /api/v1/accounts/1/statuses", json([]));
  const out = await w.fake.callTool("mastodon_profile", {});
  expect(out).toContain("@me");
  expect(out).toContain("No posts to show.");
  w.routes.set("GET /api/v1/accounts/lookup", json({ error: "Record not found" }, { status: 404 }));
  expect(await w.fake.callTool("mastodon_profile", { account: "@nobody@x.test" })).toBe(
    "No account @nobody@x.test found on masto.test.",
  );
});

test("search lists accounts, posts and hashtags, or says nothing was found", async () => {
  const w = await world();
  w.signedIn();
  w.routes.set(
    "GET /api/v2/search",
    json({
      accounts: [account()],
      statuses: [status("8")],
      hashtags: [
        {
          name: "bun",
          url: "https://masto.test/tags/bun",
          history: [{ uses: "12", accounts: "4" }],
        },
      ],
    }),
  );
  const out = await w.fake.callTool("mastodon_search", { query: "bun", type: "all" });
  expect(out).toContain("## Accounts");
  expect(out).toContain("## Posts");
  expect(out).toContain("#bun · 12 uses by 4 people today · https://masto.test/tags/bun");
  expect(out).not.toContain("Next page");
  w.routes.set("GET /api/v2/search", json({ accounts: [], statuses: [], hashtags: [] }));
  expect(await w.fake.callTool("mastodon_search", { query: "zzz" })).toBe(
    'Nothing found for "zzz".',
  );
});

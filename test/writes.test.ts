import { expect, test } from "bun:test";
import { account, json, status, world } from "./world";

const PNG = { bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]), type: "image/png" };
const posted = (body: Record<string, unknown>) => json({ ...status("900"), ...body, id: "900" });
const sentJson = (body: unknown) => JSON.parse(String(body)) as Record<string, unknown>;

test("post: the card shows the exact text, visibility and CW, and Confirm sends it", async () => {
  const w = await world({ signedIn: true });
  w.routes.set(
    "POST /api/v1/statuses",
    posted({ visibility: "unlisted", url: "https://masto.test/@me/900" }),
  );
  const out = await w.fake.callTool("mastodon_post", {
    text: "Hello <b>fediverse</b>\nsecond line",
    visibility: "unlisted",
    spoiler_text: "greetings",
  });
  expect(w.fake.confirms).toHaveLength(1);
  const card = w.fake.confirms[0];
  expect(card?.title).toBe("Post to Mastodon");
  expect(card?.content).toBe("Hello <b>fediverse</b>\nsecond line");
  expect(card?.summary).toContain("unlisted");
  expect(card?.summary).toContain("content warning");
  expect(card?.details).toContain("Visibility: unlisted");
  expect(card?.details).toContain("Content warning: greetings");
  expect(card?.details).toContain("Account: @me on masto.test");
  expect(card?.details).toContain("Images: none");
  const sent = w.requests("POST /api/v1/statuses");
  expect(sent).toHaveLength(1);
  expect(sentJson(sent[0]?.body)).toEqual({
    status: "Hello <b>fediverse</b>\nsecond line",
    visibility: "unlisted",
    spoiler_text: "greetings",
  });
  expect(sent[0]?.headers.get("Idempotency-Key")).toBe("fixed-uuid");
  expect(out).toBe("Posted (unlisted): https://masto.test/@me/900 (id 900)");
});

test("post: Cancel sends nothing and answers exactly 'Not done: you cancelled'", async () => {
  const w = await world({ signedIn: true, confirm: false });
  w.files.set("/pics/a.png", PNG);
  const out = await w.fake.callTool("mastodon_post", {
    text: "no",
    images: [{ path: "/pics/a.png" }],
  });
  expect(out).toBe("Not done: you cancelled");
  expect(w.fake.confirms).toHaveLength(1);
  // Not even the upload happens before the reader confirms.
  expect(w.seen).toEqual([]);
});

test("post: images are uploaded after Confirm, polling a 202 until processed, then attached", async () => {
  const w = await world({ signedIn: true });
  w.files.set("/pics/a.png", PNG);
  w.files.set("/pics/b.png", PNG);
  w.routes.set("POST /api/v2/media", (seen) => {
    const form = seen.body as FormData;
    const name = (form.get("file") as File).name;
    return json({ id: name === "a.png" ? "m1" : "m2" }, { status: name === "a.png" ? 202 : 200 });
  });
  let polls = 0;
  w.routes.set("GET /api/v1/media/m1", () => {
    polls += 1;
    return json({ id: "m1" }, { status: polls < 3 ? 206 : 200 });
  });
  w.routes.set("POST /api/v1/statuses", posted({}));
  const out = await w.fake.callTool("mastodon_post", {
    text: "pics",
    images: [{ path: "/pics/a.png", alt: "first" }, "/pics/b.png"],
  });
  const card = w.fake.confirms[0];
  expect(card?.summary).toContain("2 images");
  expect(card?.details).toContain("Image 1: /pics/a.png (image/png, 7 bytes), alt text: first");
  expect(card?.details).toContain("Image 2: /pics/b.png (image/png, 7 bytes), alt text: none");
  const uploads = w.requests("POST /api/v2/media");
  expect(uploads).toHaveLength(2);
  const descriptions = uploads.map((each) => (each.body as FormData).get("description"));
  expect(descriptions).toEqual(["first", null]);
  expect(polls).toBe(3);
  expect(w.sleeps).toEqual([10, 10, 10]);
  expect(sentJson(w.requests("POST /api/v1/statuses")[0]?.body)["media_ids"]).toEqual(["m1", "m2"]);
  expect(out).toContain("Posted (public)");
});

test("post: media that never finishes processing posts nothing", async () => {
  const w = await world({ signedIn: true });
  w.files.set("/pics/a.png", PNG);
  w.routes.set("POST /api/v2/media", json({ id: "m1" }, { status: 202 }));
  w.routes.set("GET /api/v1/media/m1", json({ id: "m1" }, { status: 206 }));
  const out = await w.fake.callTool("mastodon_post", {
    text: "x",
    images: [{ path: "/pics/a.png" }],
  });
  expect(out).toContain("still being processed");
  expect(out).toContain("Nothing was posted");
  expect(w.requests("GET /api/v1/media/m1")).toHaveLength(5);
  expect(w.requests("POST /api/v1/statuses")).toHaveLength(0);
});

test("post: bad input is refused before any card", async () => {
  const w = await world({ signedIn: true });
  w.files.set("/x.txt", { bytes: new Uint8Array([1]), type: "text/plain" });
  expect(await w.fake.callTool("mastodon_post", { text: "  " })).toBe("text is required.");
  expect(await w.fake.callTool("mastodon_post", { text: "a", visibility: "secret" })).toContain(
    "must be one of",
  );
  expect(
    await w.fake.callTool("mastodon_post", {
      text: "a",
      images: ["a", "b", "c", "d", "e"].map((n) => `/${n}.png`),
    }),
  ).toContain("at most 4");
  expect(await w.fake.callTool("mastodon_post", { text: "a", images: ["relative.png"] })).toContain(
    "absolute path",
  );
  expect(await w.fake.callTool("mastodon_post", { text: "a", images: ["/x.txt"] })).toContain(
    "not an image",
  );
  expect(w.fake.confirms).toEqual([]);
});

test("reply: defaults to the parent's visibility, prepends mentions, shows the target", async () => {
  const w = await world({ signedIn: true });
  w.routes.set(
    "GET /api/v1/statuses/55",
    json(
      status("55", {
        visibility: "private",
        spoiler_text: "politics",
        mentions: [{ acct: "bob" }, { acct: "me" }, { acct: "ada@other.test" }],
      }),
    ),
  );
  w.routes.set("POST /api/v1/statuses", posted({ visibility: "private" }));
  const out = await w.fake.callTool("mastodon_reply", {
    status: "https://masto.test/@ada/55",
    text: "agreed",
  });
  const card = w.fake.confirms[0];
  expect(card?.title).toBe("Reply on Mastodon");
  expect(card?.content).toBe("@ada@other.test @bob agreed");
  expect(card?.details).toContain("Visibility: private");
  expect(card?.details).toContain("Content warning: politics");
  expect(card?.details).toContain(
    "Replying to: Ada L (@ada@other.test) https://masto.test/@ada/55 (id 55)",
  );
  expect(card?.details).toContain("Their post: Hello world & friends second line");
  expect(sentJson(w.requests("POST /api/v1/statuses")[0]?.body)).toEqual({
    status: "@ada@other.test @bob agreed",
    visibility: "private",
    spoiler_text: "politics",
    in_reply_to_id: "55",
  });
  expect(out).toContain("Posted (private)");
});

test("reply: a URL from another server is resolved, and a handle already typed is not doubled", async () => {
  const w = await world({ signedIn: true });
  w.routes.set("GET /api/v2/search", json({ statuses: [status("66")] }));
  w.routes.set("GET /api/v1/statuses/66", json(status("66")));
  w.routes.set("POST /api/v1/statuses", posted({}));
  await w.fake.callTool("mastodon_reply", {
    status: "https://far.test/@ada/1",
    text: "@ada@other.test thanks",
    visibility: "unlisted",
  });
  expect(w.requests("GET /api/v2/search")[0]?.url.searchParams.get("resolve")).toBe("true");
  expect(w.fake.confirms[0]?.content).toBe("@ada@other.test thanks");
  expect(w.fake.confirms[0]?.details).toContain("Visibility: unlisted");
});

test("reply: Cancel sends nothing", async () => {
  const w = await world({ signedIn: true, confirm: false });
  w.routes.set("GET /api/v1/statuses/55", json(status("55")));
  expect(await w.fake.callTool("mastodon_reply", { status: "55", text: "hm" })).toBe(
    "Not done: you cancelled",
  );
  expect(w.requests("POST /api/v1/statuses")).toHaveLength(0);
});

test("dm: the card names the recipient; Confirm sends a direct status", async () => {
  const w = await world({ signedIn: true });
  w.routes.set("GET /api/v1/accounts/lookup", json(account()));
  w.routes.set("POST /api/v1/statuses", posted({ visibility: "direct" }));
  const out = await w.fake.callTool("mastodon_dm", { to: "@ada@other.test", text: "psst" });
  const card = w.fake.confirms[0];
  expect(card?.title).toBe("Direct message on Mastodon");
  expect(card?.summary).toContain("to @ada@other.test");
  expect(card?.content).toBe("@ada@other.test psst");
  expect(card?.details).toContain(
    "Direct message to: Ada L (@ada@other.test) https://other.test/@ada",
  );
  expect(card?.details).toContain("Visibility: direct");
  expect(sentJson(w.requests("POST /api/v1/statuses")[0]?.body)).toEqual({
    status: "@ada@other.test psst",
    visibility: "direct",
  });
  expect(out).toContain("Posted (direct)");
});

test("dm: Cancel sends nothing, and an unknown recipient never reaches a card", async () => {
  const w = await world({ signedIn: true, confirm: false });
  w.routes.set("GET /api/v1/accounts/lookup", json(account()));
  expect(await w.fake.callTool("mastodon_dm", { to: "@ada@other.test", text: "psst" })).toBe(
    "Not done: you cancelled",
  );
  expect(w.requests("POST /api/v1/statuses")).toHaveLength(0);
  w.routes.set("GET /api/v1/accounts/lookup", json({ error: "nope" }, { status: 404 }));
  const before = w.fake.confirms.length;
  expect(await w.fake.callTool("mastodon_dm", { to: "@ghost@x.test", text: "hi" })).toContain(
    "No account @ghost@x.test",
  );
  expect(w.fake.confirms).toHaveLength(before);
});

test("every write says to sign in when not signed in", async () => {
  const w = await world();
  for (const [name, args] of [
    ["mastodon_post", { text: "a" }],
    ["mastodon_reply", { status: "1", text: "a" }],
    ["mastodon_dm", { to: "@a@b.test", text: "a" }],
  ] as const) {
    expect(await w.fake.callTool(name, args)).toContain("Run mastodon_sign_in");
  }
  expect(w.fake.confirms).toEqual([]);
  expect(w.seen).toEqual([]);
});

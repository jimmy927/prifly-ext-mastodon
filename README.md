# prifly-ext-mastodon

Mastodon in prifly. Ask any session in plain words and it reads your timeline,
notifications, threads, profiles and search through this extension's tools, and
posts, replies or sends a DM after you confirm a card. It works with any
Mastodon instance and uses Mastodon's official REST API only.

## Set up

1. Link the folder into prifly's extensions folder:

   ```sh
   ln -s ~/src/prifly-ext-mastodon ~/.local/share/prifly/extensions/mastodon
   ```

   (On Windows, make a directory junction to the folder at the same place.) A
   linked extension is your own checkout: prifly never updates it.
2. Enable **Mastodon** in the Extensions dialog.
3. Ask a session to sign in: "sign in to Mastodon on mastodon.social". It runs
   `mastodon_sign_in`, which opens your server's approval page in your browser.
   Approve prifly there and go back; the Extensions dialog then shows
   "Signed in as @you on your.server".

## Tools

| Tool | What it does | Asks first |
|---|---|---|
| `mastodon_sign_in(server)` | OAuth sign-in in your browser | no (you approve in the browser) |
| `mastodon_sign_out` | Revokes the token and removes the saved copy | no |
| `mastodon_timeline` | Home, local or federated; `limit`, `max_id`, `since_id` | no |
| `mastodon_notifications` | Paged with `max_id` | no |
| `mastodon_thread` | A status (URL on any server, or id) with ancestors and replies | no |
| `mastodon_profile` | `@user@host`, id, URL, or you; plus recent posts | no |
| `mastodon_search` | Accounts, posts and hashtags | no |
| `mastodon_post` | Text, `visibility`, `spoiler_text`, up to 4 images | card |
| `mastodon_reply` | Reply by URL or id; parent's visibility, `@mentions` added | card |
| `mastodon_dm` | Direct message to `@user@host` | card |

Statuses are shown as Markdown: author, time, URL, plain text (HTML removed),
content warning, media with alt text, and counts.

Every write shows a card with the exact text, visibility, content warning, the
reply target or recipient and the images, and sends nothing, uploads nothing,
until you press Confirm. On Cancel the tool answers "Not done: you cancelled".

## Privacy

- The access token is kept in prifly's sealed secret store for extensions
  (`api.secrets`, encrypted with the vault's device key). It is never written
  to a file in this folder, never logged, and never shown to a session.
- The extension talks only to your own server (the one you signed in to) and to
  a loopback address (`127.0.0.1`) on your machine, to catch the browser's
  redirect during sign-in. No third party, no analytics.
- Reading a thread or profile from another server goes through your server
  (`/api/v2/search?resolve=true`), as Mastodon's own apps do.
- Sign-in asks for the scopes `read write`.

## Limits it keeps

It reads the server's `X-RateLimit-*` headers. When few calls are left it
refuses further ones until the reset time and says when; on a 429 it reports
the reset time. It never retries in a loop. A 401 (revoked token) clears the
saved token and asks you to sign in again. An unreachable server is named.

## Developing

```sh
bun install        # also writes bun.lock; commit it
bun test           # all over fakes: no network, no browser, no child processes
bun run typecheck
bun run check      # biome
```

| File | What it is |
|---|---|
| `prifly-extension.json`, `prompt.md` | Manifest; the session instructions |
| `index.ts` | `activate(api)` registers the tools; `activateWith(api, deps)` for tests |
| `deps.ts` | The seams: `fetch`, browser opener, loopback server, file reader |
| `client.ts` | Requests: unreachable, 401, 429 and rate-limit handling |
| `store.ts` | The account and per-server app, in `api.secrets` |
| `auth-tools.ts` | Sign-in and sign-out |
| `read-tools.ts`, `write-tools.ts`, `media.ts` | The reads; the confirmed writes; image upload with the 202 poll |
| `render.ts`, `resolve.ts`, `tool.ts` | Markdown rendering; URL/id resolution; tool helpers |
| `test/world.ts` | A fake Mastodon server, browser, loopback callback, disk and `api.secrets` |

MIT licensed.

/**
 * The Mastodon extension: what prifly imports. `activate` registers the
 * tools: sign-in and sign-out, five reads that run at once, and three
 * writes (post, reply, DM) that each ask the reader on a card first.
 * The network, browser, loopback server and disk are `Deps`, so tests
 * run over fakes (`activateWith`).
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { authTools } from "./auth-tools";
import { type Deps, defaultDeps } from "./deps";
import { readTools } from "./read-tools";
import { type Ctx, loadAccount, showStatus } from "./store";
import { writeTools } from "./write-tools";

export function activateWith(given: ExtensionApi, deps: Deps): () => void {
  let current: ExtensionApi | null = given;
  const ctx: Ctx = { api: () => current, deps };
  const tools = [...authTools(ctx), ...readTools(ctx), ...writeTools(ctx)];
  given.tools?.register(tools);
  given.log("activated", { tools: tools.length });
  void loadAccount(ctx).then((account) => showStatus(ctx, account));
  return () => {
    current = null;
  };
}

export function activate(given: ExtensionApi): () => void {
  return activateWith(given, defaultDeps(given));
}

/** The parts of Mastodon's REST entities this extension reads. */

export type Account = {
  id: string;
  username: string;
  acct: string;
  display_name?: string;
  url?: string;
  note?: string;
  followers_count?: number;
  following_count?: number;
  statuses_count?: number;
  created_at?: string;
  bot?: boolean;
  locked?: boolean;
};

export type MediaAttachment = {
  id: string;
  type: string;
  url?: string | null;
  description?: string | null;
};

export type Mention = { acct: string };

export type Status = {
  id: string;
  url?: string | null;
  uri?: string;
  created_at: string;
  account: Account;
  content: string;
  spoiler_text?: string;
  visibility: string;
  sensitive?: boolean;
  in_reply_to_id?: string | null;
  reblog?: Status | null;
  media_attachments?: MediaAttachment[];
  mentions?: Mention[];
  replies_count?: number;
  reblogs_count?: number;
  favourites_count?: number;
};

export type MastodonNotification = {
  id: string;
  type: string;
  created_at: string;
  account: Account;
  status?: Status | null;
};

export type Tag = {
  name: string;
  url?: string;
  history?: { uses: string; accounts: string }[];
};

export type SearchResults = { accounts?: Account[]; statuses?: Status[]; hashtags?: Tag[] };

export type StatusContext = { ancestors: Status[]; descendants: Status[] };

/** What the extension keeps of the signed-in account: the token lives only in `api.secrets`. */
export type StoredAccount = { server: string; token: string; acct: string };

/** The OAuth app registered on one server, for the redirect it was registered with. */
export type StoredClient = { client_id: string; client_secret: string; redirect_uri: string };

export const VISIBILITIES = ["public", "unlisted", "private", "direct"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

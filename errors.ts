/** An outcome a reader should be told in plain words: a tool returns its message instead of failing. */
export class UserError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "UserError";
    this.status = status;
  }
}

/** What a session is told when the reader said no: it must not try another way. */
export const CANCELLED = "Not done: you cancelled";

export const NOT_SIGNED_IN =
  "Not signed in to Mastodon. Run mastodon_sign_in with the reader's server (for example mastodon.social).";

---
setup:
  - "sh -c 'test ! -f package.json || bun install --frozen-lockfile'"
---

A prifly extension built from prifly's `templates/prifly-ext-template`: one bun package,
no workspaces. Tests run with `bun test`.

The repository is still empty on `main` (only an initial commit), so the step skips the
install while there is no `package.json`; once the extension lands, it installs from
`bun.lock`.

Relies on, outside the worktree:
- `bun` on PATH.
- The reader's GitHub ssh key: `@prifly/extension-api` is a git dependency on the private
  mirror `jimmy927/prifly-extension-api`, fetched over ssh at a `v<version>` tag.

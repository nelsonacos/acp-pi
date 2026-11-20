# acp-pi

## Credentials and GitHub

API tokens for this repository live **outside** it, one file per repo: `~/.config/pi-tokens/<repo>`
(mode 600). Never paste one into a conversation, a commit or a log. `gh auth status` reporting "not
logged into any GitHub hosts" is not a blocker — export `GH_TOKEN` from that file or call the API
directly, and the token covers reading the repo, pushing branches and opening issues/PRs.

Full rules: the `credentials` skill (`~/.agents/skills/credentials/SKILL.md`, source of truth in
`nelsonacos/astro` → `skills/credentials`).

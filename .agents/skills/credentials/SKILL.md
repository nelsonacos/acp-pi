---
name: credential-handling
description: "Trigger: using an API token, git credential, OAuth flow or any credential while working in a repository on this machine."
---

## Rules

- **One file per repository**, at `~/.config/pi-tokens/<repo>`, mode `600`. Never in the
  repository, never in a file a shell history could echo.
- **Never paste a credential into a conversation**, a commit, a log or a document. If one
  appears in a transcript, treat it as compromised and rotate it.
- **Export before using it in a shell helper.** A git credential helper runs in its own
  shell:

  ```sh
  export GH_TOKEN=$(cat ~/.config/pi-tokens/<repo>)     # export, not a plain assignment
  git -c credential.helper='!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f' push
  ```

  Without `export`, the helper receives an empty password and GitHub answers
  `Invalid username or token`. The message blames the token; the bug is the shell.
- **Verify a token with the API, never by printing it**:

  ```sh
  curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
    https://api.github.com/repos/<owner>/<repo>
  ```

  `200` means valid. `401` means the token is wrong; `404` means it is fine but not
  scoped to that repository.
- **No browser is available on this machine.** OAuth flows that need a local callback
  cannot finish; use a personal access token instead.

## Check

Before finishing: a search for `ghp_` or `github_pat_` over the repository returns
nothing, and the credential lives only in `~/.config/pi-tokens/` with mode `600`.

---
name: moshi-notifications
description: "Trigger: notificar, notify, avisar, Moshi, push al móvil, task done, task failed, bloqueado, necesito tu ayuda. Send a Moshi push notification to the user's phone when a task finishes, fails, or needs their input."
license: Apache-2.0
metadata:
  author: Nelson Acosta
  version: "1.0"
---

## Activation Contract

Use this skill while doing work in this repository. Notify the user by Moshi push when:
- a task or milestone finishes successfully;
- a task or check fails and cannot be fixed automatically;
- work is blocked and needs the user's decision or assistance.

## Hard Rules

- Send the push with the `moshi-hook` daemon: `~/.local/bin/moshi-hook notify --source pi --title "<título>" "<mensaje>"`.
- Mark failures with `--error`; when you cannot proceed without a user answer, add `--strict` so the send is confirmed (or use `~/.local/bin/moshi-hook ask` for a blocking approval on the phone).
- Keep messages short and actionable: what happened, and (when blocked) exactly what you need.
- Never put secrets, credentials, tokens, or private data in a notification.
- Do not notify for routine progress that needs no user action; reserve pushes for finish, failure, or needed input.
- The old `~/.local/bin/notify-mobile` script does NOT exist on this host; the active integration is the `moshi-hook` daemon.

## Decision Gates

| Situation | Action |
| --- | --- |
| Task finished successfully | `moshi-hook notify --source pi --title "..." "..."` |
| Task/check failed | `moshi-hook notify --error --source pi --title "..." "..."` |
| Blocked, needs a user decision | `moshi-hook notify --strict --source pi --title "..." "..."` (or `ask` for a blocking approval) |
| Routine intermediate progress | Do not notify. |

## Execution Steps

1. On finish, failure, or block, compose a one- or two-line message.
2. Run the matching `moshi-hook notify` command from the table above.
3. If the daemon is down (`systemctl --user is-active moshi-hook`), report that in your turn and log it to Engram or an emergency record; do not silently drop the notification.

## Output Contract

When this skill is activated, return:
- the message sent (without any secret content);
- whether the push succeeded or failed.

## References

- Daemon: `~/.local/bin/moshi-hook` (systemd user service `moshi-hook`, socket `/run/user/1000/moshi-hook.sock`, status `paired`).
- `moshi-hook notify --help` and `moshi-hook ask --help` for the full flag set.

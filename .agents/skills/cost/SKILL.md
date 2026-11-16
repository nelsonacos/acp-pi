---
name: model-cost-discipline
description: "Trigger: starting a session, choosing a model, or working on a long task that will read many files."
---

## Rules

- **Check before you choose**: `/tokens` (last 30 days), `/tokens 7` (the week). The
  number decides, not the mood.
- **Cheap model by default.** On this machine that is `deepseek-flash`. Most work —
  reading files, explaining code, writing a test, a small refactor — does not need more.
- **Expensive model with a reason**, not by default: architecture, bugs that will not
  reproduce, migrations, and reviewing unfamiliar code.
- **Reasoning is not free.** Raising the thinking level on a cheap model can cost more
  than using a stronger model without it. Set it deliberately.
- **Cache reads dominate token counts but not the bill.** A session re-sends the
  conversation each turn; what it costs depends far more on which model answers than on
  how much is replayed.

## Evidence behind these rules

Measured on 2026-11-17 from the transcripts: **$48.51 in nine days** (~$5.39 per active
day, about $162 per month), and **74% of it went to one model** while a much cheaper one
was available. The bill was model choice, not volume.

## Check

At the end of a working day, `/tokens 1` should show a figure you could justify out loud.
If it needs explaining, the model choice was wrong, not the task.

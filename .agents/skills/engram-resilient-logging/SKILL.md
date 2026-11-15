---
name: engram-resilient-logging
description: "Trigger: registrar en engram, guardar en memoria, record progress, log outcome, emergency record, registro de emergencia, engram falló/failed, resume work, cerrar tarea, ¿está registrado?. Persist every work outcome to Engram and fall back to on-disk emergency logs when Engram is down."
license: Apache-2.0
metadata:
  author: Nelson Acosta
  version: "1.1"
---

## Activation Contract

Apply to every project in this repository while doing work. Activate when:
- a work unit, task, or verification finishes (success or failure);
- a decision is made that must survive a session cut or an Engram outage;
- a user asks whether something is registered/pushed;
- an Engram write fails or Engram is unreachable.

## Hard Rules

- Log every significant outcome immediately (success AND failure). Never defer or batch.
- Use the Engram canonical topic workflow: search → read in full → update the same topic, or save a new one only if genuinely new. Never duplicate.
- **Before reporting a task as done**, verify the outcome is in Engram. If it is not, record it before replying. Do not say "listo"/"hecho" with unrecorded work.
- If an Engram write fails (down, timeout, error), do NOT skip it: write an emergency record on disk in `<repo>/engram-emergency/`.
- An emergency record holds the same payload you would have saved to Engram: title, type, scope, topic_key, and full content.
- On the next healthy Engram session, replay pending emergency records into Engram, then mark each as migrated.
- Never persist secrets, credentials, or private data in Engram or emergency records.

## Decision Gates

| Situation | Action |
| --- | --- |
| Engram write succeeds | Continue; nothing else required. |
| Engram write fails | Create `engram-emergency/<YYYYMMDD-HHMMSS>-<topic_key>.md`. |
| Emergency records exist at session start | Replay into Engram before starting new work. |
| Engram healthy again after an outage | Replay pending records, then mark them `MIGRATED`. |
| About to report work as finished | Confirm the record exists (search by topic_key) first. |
| User asks "is it pushed/registered?" | Check `git status -sb` for every repo AND search Engram; report both. |

## Execution Steps

1. At the start of a session, check `engram-emergency/` for unreplayed records and migrate them.
2. After each significant outcome, search Engram for the topic (project- and scope-scoped).
3. `mem_update` the existing topic or `mem_save` a genuinely new one, per the canonical workflow.
4. If that write fails, write an `engram-emergency/` file with the same fields and content.
5. Commit the emergency record to git (this repo is private) so it survives a disk loss.
6. Report in your turn whether the record succeeded or fell back to emergency.

## Output Contract

When this skill is activated, return:
- the Engram topic saved/updated, or the emergency file path if Engram was down;
- whether the write succeeded or fell back to emergency;
- any pending emergency records still unreplayed.

## References

- Engram canonical topic workflow: `mem_search` → `mem_get_observation` → `mem_update`/`mem_save`.
- Emergency log directory: `<repo>/engram-emergency/` (do not gitignore; this repo is private).

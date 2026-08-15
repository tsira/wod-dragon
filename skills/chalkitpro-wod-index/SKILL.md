---
name: chalkitpro-wod-index
description: 'Index and query CrossFit WODs from Chalk It Pro for the WOD DRAGON timer project. Use when the user says "index WODs", "sync chalkitpro", "update the workout corpus", "what did we do at the gym", "what WOD was programmed on <date>", "suggest a timer config for today''s WOD", "update today''s presets", or asks to refresh scheme analysis. Fetches missing days incrementally via the Chalk It Pro API, rebuilds the WOD index with auto-detected timer configs, and can regenerate the WOD DRAGON preset file.'
---

# Chalk It Pro WOD Index

Maintains the local corpus of gym programming and answers questions from it. Repo root: `~/spg/wod-dragon` (referred to as `{repo}`). Planning docs live separately in second-brain at `my-notes/Projects/Crossfit-Timer-Watch-App/`.

## Data layout

| Path | What |
|---|---|
| `{repo}/data/api/wods/YYYY-MM-DD.json` | Raw per-day API payloads (a day = 4-7 segments). Gitignored personal data |
| `{repo}/data/wod-index.json` | Machine index: per segment, timer relevance, scheme signals, suggested timer config |
| `{repo}/data/WOD-Index.md` | Human index, last 45 days, timer-relevant segments only |
| `{repo}/site/presets.js` | Generated presets consumed by the webapp (committed) |

## Commands

Sync + reindex (default, incremental — only fetches missing days):

```bash
python3 ~/spg/wod-dragon/scripts/index-wods.py
```

- Extend history: `--backfill 180`
- Rebuild index without network: `--analyze-only`
- Regenerate webapp presets from a day: `--emit-presets` (latest) or `--emit-presets YYYY-MM-DD`

Daily preset flow: `index-wods.py --emit-presets` then `quick deploy {repo}/site wod-dragon` (deploy needs the user's y/n confirm — never bypass it).

## Auth (never in chat)

Token file: `~/.config/chalkitpro/token` (chmod 600). If missing/expired, the script exits with instructions; relay them: log in at app.chalkitpro.com → DevTools → Application → Local Storage → copy `jwt_access_token` into the file. NEVER accept a token or password pasted into chat; never print the token.

## Answering questions

1. Run the sync first if the question involves recent days; use `--analyze-only` if offline.
2. Query `data/wod-index.json` (jq/python), not raw day files, for scheme/frequency questions.
3. For "timer config for <day>": read that day's entry, return the `suggestedTimer` per relevant segment, but label it auto-detected and show the excerpt so the user can verify (detection is regex-based Phase 6 groundwork, not ground truth).
4. For deep WOD text (full description, levels, loads), open the raw day JSON; descriptions are HTML in `wodParts[].description`.

## Gotchas

- API day fetch is `wods/{trackId}/{userId}/{MM-dd-yyyy}/0/0/{MM-dd-yyyy}%2020:00:00`; the two middle params are ignored by the server. Identity (user id, track id) comes from `auth/getUserInfo` at runtime; never hardcode account identifiers.
- `scoreStyle`/`timeCapSeconds` fields are unreliable; trust the description text.
- Titles matching warm-up/accessory/prep/primer/PRVN Reset are marked not timer-relevant; don't surface them in timer answers unless asked.
- Occasional days 404/parse-fail on the API; the script skips them: rerun later rather than treating as rest days.
- `data/` is gitignored personal data; don't copy WOD payloads into shared repos or chat beyond short excerpts. `site/presets.js` is committed, so keep preset content to movement names/reps only.
- Sets+Rest detection under-triggers (regex misses "between sets" phrasings); known Phase 6 gap.

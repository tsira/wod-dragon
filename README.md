# WOD DRAGON 🐉

90s retro (Far Cry 3: Blood Dragon themed) CrossFit timer. Web prototype now; Pixel Watch 4 (Wear OS) app is the end goal.

## Layout

| Path | What |
|---|---|
| `site/` | The webapp (vanilla JS, no build step). `site/engine.js` is the pure timer engine and the portable spec for the Wear OS port |
| `site/tests/` | Engine test suite (21 tests), scenarios from real gym programming |
| `scripts/index-wods.py` | Fetches WOD history from Chalk It Pro (JWT auth), builds the scheme index, generates `site/presets.js` |
| `scripts/fetch-chalkitpro.sh` | Low-level API probe/fetch helper |
| `skills/chalkitpro-wod-index/` | Agent skill for syncing/querying the WOD corpus |
| `data/` | Gitignored: personal WOD corpus + generated indexes |

## Run

```bash
cd site && quick serve          # local dev (Shopify Quick)
node --test 'site/tests/*.test.js'   # engine tests
```

## Deploy

```bash
quick deploy site wod-dragon    # -> wod-dragon.quick.shopify.io
```

## Daily preset flow

```bash
python3 scripts/index-wods.py --emit-presets   # sync corpus, regen site/presets.js from today's WOD
quick deploy site wod-dragon
```

Auth: Chalk It Pro JWT in `~/.config/chalkitpro/token` (chmod 600). Copy `jwt_access_token` from browser localStorage after logging in at app.chalkitpro.com. Never commit tokens.

## Timer modes

ENOM (every N interval x sets, rotating per-station labels), FOR TIME (optional cap), AMRAP, SETS+REST (open work, tap done, fixed rest). No pause, by design. Cues: square-wave audio + vibration patterns, configurable end-anchored (3-2-1 into next) or start-anchored (blast at start).

Design spec, requirements, scheme research, and decision log live in the owner's second-brain project folder (`my-notes/Projects/Crossfit-Timer-Watch-App/`).

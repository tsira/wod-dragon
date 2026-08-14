#!/usr/bin/env python3
"""Index Chalk It Pro WODs into the project corpus.

- Incrementally fetches missing days from the Chalk It Pro API (JWT auth).
- Rebuilds the machine index (workout-samples/wod-index.json) and the
  human index (WOD-Index.md) with scheme detection and suggested
  WOD DRAGON timer configs (early Phase 6 groundwork).

Usage:
  python3 index-wods.py                 # fetch missing days, rebuild index
  python3 index-wods.py --backfill 120  # extend history window (days)
  python3 index-wods.py --analyze-only  # no network, rebuild index from disk
  python3 index-wods.py --emit-presets [YYYY-MM-DD]
                                        # also regenerate wod-dragon/presets.js
                                        # from that day's WODs (default: latest)

Token: ~/.config/chalkitpro/token (chmod 600). Never pass tokens via argv/chat.
"""
import argparse
import base64
import datetime as dt
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJ = SCRIPT_DIR.parent
WODS_DIR = PROJ / "data" / "api" / "wods"
INDEX_JSON = PROJ / "data" / "wod-index.json"
INDEX_MD = PROJ / "data" / "WOD-Index.md"
TOKEN_FILE = Path.home() / ".config" / "chalkitpro" / "token"
API = "https://api.chalkitpro.com/api"

TIMER_IRRELEVANT = re.compile(r"warm.?up|accessor|prep|primer|prvn reset", re.I)
PRESETS_JS = PROJ / "site" / "presets.js"
STATION_RX = re.compile(r"Minute\s*\d+\s*:\s*(.+?)(?=Minute\s*\d+\s*:|$)")


# ---------------- API ----------------
def read_token():
    if not TOKEN_FILE.is_file():
        sys.exit(
            "No token. Log in at app.chalkitpro.com, copy localStorage jwt_access_token to "
            f"{TOKEN_FILE} (chmod 600)."
        )
    tok = TOKEN_FILE.read_text().strip()
    try:
        payload = tok.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        exp = json.loads(base64.urlsafe_b64decode(payload)).get("exp")
        if exp and exp < time.time():
            sys.exit("Token expired. Grab a fresh jwt_access_token from the browser.")
    except sys.exit.__class__:
        raise
    except Exception:
        pass  # opaque token, let the API decide
    return tok


def api_get(token, path):
    req = urllib.request.Request(
        f"{API}/{path}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def get_identity(token):
    info = api_get(token, "auth/getUserInfo")["user"]["data"]
    track = info["gyms"][0]["tracks"][0]
    return info["id"], track["id"], track.get("trackName", "?")


def fetch_day(token, track_id, user_id, day):
    ds = day.strftime("%m-%d-%Y")
    return api_get(token, f"wods/{track_id}/{user_id}/{ds}/0/0/{ds}%2020:00:00")


# ---------------- scheme detection ----------------
def strip_html(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def mss(m, s="0"):
    return int(m) * 60 + int(s or 0)


def detect(text):
    """Return (signals, suggestion) for one segment's description text."""
    sig, sug = [], None

    m = re.search(r"[Ee]very\s+(\d+):(\d{2})\s*x\s*(\d+)", text)
    if m:
        sig.append(f"EnMOM {m[1]}:{m[2]} x {m[3]}")
        sug = {"mode": "enmom", "intervalSec": mss(m[1], m[2]), "sets": int(m[3])}
    m2 = re.search(r"(\d+):(\d{2})\s*EMOM", text) or re.search(r"EMOM\s*x?\s*(\d+):(\d{2})", text)
    if m2 and not sug:
        total = mss(m2[1], m2[2])
        sig.append(f"EMOM {m2[1]}:{m2[2]}")
        sug = {"mode": "enmom", "intervalSec": 60, "sets": total // 60}

    m = re.search(r"(\d+):(\d{2})\s*AMRAP", text) or re.search(r"AMRAP\s*(?:x\s*)?(\d+):(\d{2})", text)
    if m:
        sig.append(f"AMRAP {m[1]}:{m[2]}")
        sug = sug or {"mode": "amrap", "durationSec": mss(m[1], m[2])}

    if re.search(r"[Ff]or [Tt]ime", text):
        cap = re.search(r"[Tt]ime\s?[Cc]ap\s*:?\s*(\d+):(\d{2})", text)
        sig.append("For Time" + (f" cap {cap[1]}:{cap[2]}" if cap else ""))
        sug = sug or {"mode": "fortime", "capSec": mss(cap[1], cap[2]) if cap else None}

    sets_rest = re.search(r"(\d+)\s*[Ss]ets\b", text), re.search(r"[Rr]est\s*:?\s*(\d+):(\d{2})", text)
    if sets_rest[0] and sets_rest[1]:
        sig.append(f"{sets_rest[0][1]} sets / rest {sets_rest[1][1]}:{sets_rest[1][2]}")
        sug = sug or {
            "mode": "setsrest",
            "sets": int(sets_rest[0][1]),
            "restSec": mss(sets_rest[1][1], sets_rest[1][2]),
        }

    for label, rx in [
        ("ladder", r"\b\d{1,2}-\d{1,2}(?:-\d{1,2})+\b"),
        ("rounds", r"\d+\s+[Rr]ounds"),
        ("partner", r"[Pp]artner|[Tt]eam of"),
        ("alternating", r"[Aa]lternat"),
        ("tabata", r"[Tt]abata"),
        ("death by", r"[Dd]eath [Bb]y"),
    ]:
        if re.search(rx, text):
            sig.append(label)
    return sig, sug


def build_index():
    days = []
    for f in sorted(WODS_DIR.glob("*.json")):
        wods = json.loads(f.read_text())
        segs = []
        for w in wods:
            title = (w.get("title") or "").strip() or "(untitled)"
            relevant = not TIMER_IRRELEVANT.search(title)
            parts = w.get("wodParts") or []
            text = strip_html(parts[0].get("description")) if parts else ""
            sig, sug = detect(text) if relevant else ([], None)
            segs.append(
                {
                    "title": title,
                    "timerRelevant": relevant,
                    "signals": sig,
                    "suggestedTimer": sug,
                    "levels": len(parts),
                    "excerpt": text[:500],
                }
            )
        days.append({"date": f.stem, "segments": segs})
    return days


def write_outputs(days):
    INDEX_JSON.write_text(json.dumps({"generated": dt.datetime.now().isoformat(), "days": days}, indent=1))
    lines = [
        "# WOD Index",
        "",
        "#project/crossfit-timer",
        "",
        f"Generated {dt.date.today()} by `scripts/index-wods.py` from {len(days)} days in "
        "`data/api/wods/`. Machine version: `data/wod-index.json`.",
        "",
        "Timer suggestions are auto-detected (Phase 6 groundwork); verify before trusting.",
        "",
    ]
    for d in reversed(days[-45:]):
        rel = [s for s in d["segments"] if s["timerRelevant"]]
        if not rel:
            continue
        lines.append(f"## {d['date']}")
        for s in rel:
            sug = s["suggestedTimer"]
            sug_txt = (
                f" → `{sug['mode']}` " + json.dumps({k: v for k, v in sug.items() if k != "mode"})
                if sug
                else ""
            )
            sig = f" [{', '.join(s['signals'])}]" if s["signals"] else ""
            lines.append(f"- **{s['title']}**{sig}{sug_txt}")
        lines.append("")
    INDEX_MD.write_text("\n".join(lines))


def extract_stations(text):
    """Pull rotating per-minute stations out of an EMOM description."""
    out = []
    for m in STATION_RX.findall(text):
        # cut trailing equipment notes ("Kettlebell : ...") from the last station
        st = re.split(r"\b(?:Kettlebell|Barbell|Box|Dumbbell|Wall Ball)\s*:", m)[0]
        st = re.sub(r"\s+", " ", st).strip(" .;,")
        if st:
            out.append(st[:60])
    return out


def preset_name(title):
    q = re.search(r'"([^"]+)"', title)
    if q:
        return q[1].upper()
    return re.sub(r"^(Strength|Weightlifting|Conditioning|Workout)\s*:\s*", "", title).strip()[:28].upper()


def emit_presets(days, date_str):
    day = next((d for d in days if d["date"] == date_str), None)
    if not day:
        sys.exit(f"no indexed day {date_str}")
    presets = []
    for s in day["segments"]:
        sug = s.get("suggestedTimer")
        if not (s["timerRelevant"] and sug):
            continue
        fields = {}
        text = s["excerpt"]
        if sug["mode"] == "enmom":
            fields = {
                "interval": f"{sug['intervalSec'] // 60}:{sug['intervalSec'] % 60:02d}",
                "sets": str(sug["sets"]),
                "stations": "\n".join(extract_stations(text))
                or re.sub(r".*x\s*\d+\s*Sets?\s*", "", text)[:60].strip(),
            }
        elif sug["mode"] == "amrap":
            fields = {"duration": f"{sug['durationSec'] // 60}:{sug['durationSec'] % 60:02d}",
                      "scheme": text[:70]}
        elif sug["mode"] == "fortime":
            cap = sug.get("capSec")
            fields = {"cap": f"{cap // 60}:{cap % 60:02d}" if cap else "", "scheme": text[:70]}
        elif sug["mode"] == "setsrest":
            fields = {"sets": str(sug["sets"]),
                      "rest": f"{sug['restSec'] // 60}:{sug['restSec'] % 60:02d}",
                      "scheme": text[:70]}
        presets.append({"name": preset_name(s["title"]), "date": date_str,
                        "mode": sug["mode"], "fields": fields})
    PRESETS_JS.write_text(
        "/* Generated by scripts/index-wods.py --emit-presets. Manual edits may be overwritten. */\n"
        "'use strict';\n"
        f"const PRESETS = {json.dumps(presets, indent=2)};\n"
    )
    print(f"emitted {len(presets)} preset(s) for {date_str} -> {PRESETS_JS}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", type=int, default=84, help="history window in days")
    ap.add_argument("--analyze-only", action="store_true", help="skip network fetch")
    ap.add_argument("--emit-presets", nargs="?", const="latest", default=None,
                    metavar="YYYY-MM-DD", help="regenerate wod-dragon/presets.js from a day")
    args = ap.parse_args()

    WODS_DIR.mkdir(parents=True, exist_ok=True)

    if not args.analyze_only:
        token = read_token()
        user_id, track_id, track_name = get_identity(token)
        print(f"account {user_id}, track {track_id} ({track_name})")
        have = {f.stem for f in WODS_DIR.glob("*.json")}
        today = dt.date.today()
        missing = [
            d
            for i in range(args.backfill + 1)
            if (d := today - dt.timedelta(days=i)).isoformat() not in have
        ]
        print(f"fetching {len(missing)} missing day(s)...")
        fetched = 0
        for day in sorted(missing):
            try:
                data = fetch_day(token, track_id, user_id, day)
            except (urllib.error.URLError, json.JSONDecodeError) as e:
                print(f"  {day}: skip ({e})")
                continue
            if data:
                (WODS_DIR / f"{day.isoformat()}.json").write_text(json.dumps(data))
                fetched += 1
            time.sleep(0.25)
        print(f"fetched {fetched} day(s) with programming")

    days = build_index()
    write_outputs(days)
    n_seg = sum(len(d["segments"]) for d in days)
    n_sug = sum(1 for d in days for s in d["segments"] if s["suggestedTimer"])
    print(f"indexed {len(days)} days, {n_seg} segments, {n_sug} timer suggestions")
    print(f"-> {INDEX_MD}\n-> {INDEX_JSON}")

    if args.emit_presets:
        date_str = days[-1]["date"] if args.emit_presets == "latest" else args.emit_presets
        emit_presets(days, date_str)


if __name__ == "__main__":
    main()

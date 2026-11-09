"""모험가의 길 Discord poller — runs every ~10 minutes on GitHub Actions (standard library only).

1. Welcome wave: a member-join system message in the server's system channel gets a reply with a random standard
   "wave" sticker, the same thing Discord's 「Wave to say hi!」 button sends.
2. Inbox: new posts and new replies (not from the bot or the server owner) in the forum channels are summed up in
   one message in the notify channel, mentioning the server owner.

Secret : env DISCORD_BOT_TOKEN (GitHub Actions secret). Never printed.
State  : state/state.json (kept between runs by actions/cache). Without it (first run, evicted cache) the run only
         records a baseline, so nothing old is greeted or reported again.
Local  : DISCORD_BOT_TOKEN=... python poll.py [--dry]   (--dry = read and print, post nothing, keep the state)
"""
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request

API = "https://discord.com/api/v10"
UA = "DiscordBot (https://maplestoryworlds.nexon.com, 1.0) MapleSpire-poll"
HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, "state", "state.json")

FORUMS = {"질문-qna": "질문", "버그-제보-bug-reports": "버그", "건의-suggestions": "건의", "번역-오류-translation": "번역"}
NOTIFY_CHANNEL = "moderator-only"
# standard stickers that read as a greeting (the wave button picks one of its own set at random)
WAVE_STICKERS = ["749054660769218631", "754108890559283200", "781291131828699156", "751606379340365864",
                 "783787234091466793", "816086581509095424", "816087792291282944"]
GREET_MAX_AGE = 24 * 3600          # never greet a join older than this (a re-baselined state stays quiet)
MAX_NOTE = 1900                    # Discord message limit is 2000
DRY = "--dry" in sys.argv


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def call(method, path, body=None):
    tok = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    if not tok:
        sys.exit("DISCORD_BOT_TOKEN is not set")
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    for _ in range(6):
        req = urllib.request.Request(API + path, data=data, method=method, headers={
            "Authorization": "Bot " + tok, "User-Agent": UA, "Content-Type": "application/json; charset=utf-8"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            if e.code == 429:
                try:
                    wait = float(json.loads(raw).get("retry_after", 1))
                except ValueError:
                    wait = 1.0
                time.sleep(wait + 0.2)
                continue
            raise RuntimeError("Discord API %s %s -> %d %s" % (method, path, e.code, raw[:200]))
    raise RuntimeError("Discord API rate limit: retries exhausted")


def snow_time(sid):
    # a snowflake id → unix seconds
    return ((int(sid) >> 22) + 1420070400000) / 1000.0


def time_snow(sec):
    # unix seconds → the smallest snowflake id of that moment (for "messages after this time")
    return (int(sec * 1000) - 1420070400000) << 22


def load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def save_state(st):
    if DRY:
        return
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=1)


def snippet(text, n=80):
    t = " ".join((text or "").split())
    return t if len(t) <= n else t[:n - 1] + "…"


def main():
    me = call("GET", "/users/@me")
    guilds = call("GET", "/users/@me/guilds")
    gid = os.environ.get("DISCORD_GUILD_ID") or guilds[0]["id"]
    guild = call("GET", "/guilds/%s" % gid)
    owner = guild["owner_id"]
    chans = call("GET", "/guilds/%s/channels" % gid)
    by_name = {c["name"]: c for c in chans}
    forum_ids = {by_name[n]["id"]: label for n, label in FORUMS.items() if n in by_name}
    sys_ch = guild.get("system_channel_id")
    notify = by_name.get(NOTIFY_CHANNEL, {}).get("id")

    run_sf = time_snow(time.time())
    st = load_state()
    baseline = st is None
    if baseline:
        st = {"join_after": "0", "threads": {}}
        log("no state — recording a baseline (nothing is greeted or reported this run)")
    prev_sf = int(st.get("run_sf", run_sf))

    # ---------- 1. welcome wave ----------
    joins = []
    if sys_ch:
        msgs = call("GET", "/channels/%s/messages?limit=50" % sys_ch) or []
        waved = {m["message_reference"]["message_id"] for m in msgs
                 if m["author"]["id"] == me["id"] and m.get("message_reference")}
        newest = max([int(m["id"]) for m in msgs] + [int(st["join_after"])])
        for m in sorted(msgs, key=lambda x: int(x["id"])):
            if m["type"] != 7 or int(m["id"]) <= int(st["join_after"]) or m["id"] in waved:
                continue
            if baseline or time.time() - snow_time(m["id"]) > GREET_MAX_AGE:
                continue
            joins.append(m)
        for m in joins:
            sticker = random.choice(WAVE_STICKERS)
            log("wave", m["author"]["username"], "sticker", sticker)
            if not DRY:
                try:
                    call("POST", "/channels/%s/messages" % sys_ch, {
                        "sticker_ids": [sticker], "message_reference": {"message_id": m["id"], "fail_if_not_exists": False},
                        "allowed_mentions": {"parse": [], "replied_user": True}})
                except RuntimeError as e:
                    # fall back to a reaction if the sticker cannot be sent
                    log("sticker failed:", e)
                    call("PUT", "/channels/%s/messages/%s/reactions/%s/@me" % (sys_ch, m["id"], "%F0%9F%91%8B"))
        st["join_after"] = str(newest)

    # ---------- 2. forum inbox ----------
    notes = []
    active = call("GET", "/guilds/%s/threads/active" % gid).get("threads", [])
    for t in sorted(active, key=lambda x: int(x["id"])):
        label = forum_ids.get(t.get("parent_id"))
        if label is None:
            continue
        tid, last = t["id"], t.get("last_message_id") or t["id"]
        seen = st["threads"].get(tid)
        st["threads"][tid] = last
        if baseline:
            continue
        link = "https://discord.com/channels/%s/%s" % (gid, tid)
        if seen is None:
            # a post made since the last run (its first message has the thread's id), or an old archived post that
            # came back with a reply: only what was written since the last run
            after = int(tid) - 1 if int(tid) > prev_sf else prev_sf
            msgs = call("GET", "/channels/%s/messages?after=%d&limit=50" % (tid, after)) or []
        elif int(last) > int(seen):
            msgs = call("GET", "/channels/%s/messages?after=%s&limit=50" % (tid, seen)) or []
        else:
            continue
        msgs = [m for m in msgs if not m["author"].get("bot") and m["author"]["id"] != owner]
        if not msgs:
            continue
        msgs.sort(key=lambda x: int(x["id"]))
        first = msgs[0]
        name = first["author"].get("global_name") or first["author"]["username"]
        kind = "새 글" if seen is None and first["id"] == tid else "새 댓글 %d" % len(msgs)
        files = " (첨부 %d)" % len(first.get("attachments", [])) if first.get("attachments") else ""
        notes.append("• [%s] %s — **%s** · %s: %s%s\n  <%s>" % (label, kind, t["name"][:60], name,
                                                                 snippet(first.get("content")), files, link))
    # archived threads stay in the state (a reply brings them back as active); forget ones quiet for 180 days
    st["threads"] = {k: v for k, v in st["threads"].items() if time.time() - snow_time(v) < 180 * 86400}

    if joins:
        notes.append("• 입장 인사 %d명: %s" % (len(joins), ", ".join(m["author"]["username"] for m in joins)))
    if notes and notify:
        text = "<@%s> 디스코드 새 소식\n%s" % (owner, "\n".join(notes))
        if len(text) > MAX_NOTE:
            text = text[:MAX_NOTE] + "\n…"
        log("notify:\n" + text)
        if not DRY:
            call("POST", "/channels/%s/messages" % notify, {"content": text, "allowed_mentions": {"users": [owner]}})
    else:
        log("nothing new" if not baseline else "baseline saved: %d threads" % len(st["threads"]))
    st["last_run"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    st["run_sf"] = str(run_sf)
    save_state(st)


if __name__ == "__main__":
    main()

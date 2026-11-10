// 모험가의 길 Discord poller on Cloudflare Workers — a cron trigger runs it every 10 minutes (wrangler.toml).
// Same job as ../poll.py (which GitHub Actions ran until 11-10, when its schedules turned out to start hours late):
//   1. welcome wave: a member-join system message in the server's system channel gets a reply with a random standard
//      "wave" sticker (what Discord's 「Wave to say hi!」 button sends); a 👋 reaction if the sticker fails.
//      Bots and members who already left are skipped.
//   2. inbox: new posts and replies (not from bots or the server owner) in the forum channels are summed up in one
//      message in the notify channel, mentioning the server owner.
// Secret: DISCORD_BOT_TOKEN (wrangler secret). State: KV namespace STATE, key "state" — without it the run only records
// a baseline, so nothing old is greeted or reported. Var DRY = "1" reads and logs only (posts nothing, keeps the state).

const API = "https://discord.com/api/v10";
const UA = "DiscordBot (https://maplestoryworlds.nexon.com, 1.0) MapleSpire-worker";
const FORUMS = { "질문-qna": "질문", "버그-제보-bug-reports": "버그", "건의-suggestions": "건의", "번역-오류-translation": "번역" };
const NOTIFY_CHANNEL = "moderator-only";
// standard stickers that read as a greeting (the wave button picks one of its own set at random)
const WAVE_STICKERS = ["749054660769218631", "754108890559283200", "781291131828699156", "751606379340365864",
  "783787234091466793", "816086581509095424", "816087792291282944"];
const GREET_MAX_AGE = 24 * 3600;   // never greet a join older than this (a re-baselined state stays quiet)
const MAX_NOTE = 1900;             // Discord message limit is 2000
const SUBREQ_BUDGET = 40;          // the free plan allows 50 subrequests per invocation
const EPOCH = 1420070400000n;

// snowflake ids pass 2^53: compare them as BigInt, store them as strings
const big = (id) => BigInt(id);
const snowTime = (id) => Number((big(id) >> 22n) + EPOCH) / 1000;
const timeSnow = (sec) => (BigInt(Math.floor(sec * 1000)) - EPOCH) << 22n;
const byId = (a, b) => (big(a.id) < big(b.id) ? -1 : big(a.id) > big(b.id) ? 1 : 0);
const snippet = (text, n = 80) => {
  const t = (text || "").split(/\s+/).filter(Boolean).join(" ");
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
};

class Discord {
  constructor(token) {
    this.token = token;
    this.count = 0;
  }

  async call(method, path, body) {
    for (let attempt = 0; attempt < 4; attempt++) {
      this.count++;
      const res = await fetch(API + path, {
        method,
        headers: { Authorization: "Bot " + this.token, "User-Agent": UA, "Content-Type": "application/json; charset=utf-8" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429) {
        let wait = 1;
        try { wait = (await res.json()).retry_after || 1; } catch (e) { /* keep 1 s */ }
        await new Promise((r) => setTimeout(r, (wait + 0.2) * 1000));
        continue;
      }
      const raw = await res.text();
      if (!res.ok) throw new Error(`Discord API ${method} ${path} -> ${res.status} ${raw.slice(0, 200)}`);
      return raw ? JSON.parse(raw) : null;
    }
    throw new Error("Discord API rate limit: retries exhausted");
  }

  async isMember(gid, uid) {
    // still in the server? (a member who joined and left gets no wave)
    try {
      await this.call("GET", `/guilds/${gid}/members/${uid}`);
      return true;
    } catch (e) {
      if (String(e.message).includes("-> 404")) return false;
      throw e;
    }
  }
}

async function run(env) {
  const dry = String(env.DRY) === "1";
  const token = (env.DISCORD_BOT_TOKEN || "").trim();
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
  const dc = new Discord(token);
  const lines = [];
  const log = (...a) => {
    const s = a.join(" ");
    lines.push(s);
    console.log(s);
  };

  const me = await dc.call("GET", "/users/@me");
  const gid = env.GUILD_ID || (await dc.call("GET", "/users/@me/guilds"))[0].id;
  const guild = await dc.call("GET", `/guilds/${gid}`);
  const owner = guild.owner_id;
  const chans = await dc.call("GET", `/guilds/${gid}/channels`);
  const byName = Object.fromEntries(chans.map((c) => [c.name, c]));
  const forumIds = {};
  for (const [name, label] of Object.entries(FORUMS)) if (byName[name]) forumIds[byName[name].id] = label;
  const sysCh = guild.system_channel_id;
  const notify = byName[NOTIFY_CHANNEL] && byName[NOTIFY_CHANNEL].id;

  const now = Date.now() / 1000;
  const runSf = timeSnow(now);
  let st = await env.STATE.get("state", "json");
  const baseline = !st;
  if (baseline) {
    st = { join_after: "0", threads: {} };
    log("no state — recording a baseline (nothing is greeted or reported this run)");
  }
  const prevSf = st.run_sf ? big(st.run_sf) : runSf;

  // ---------- 1. welcome wave ----------
  const joins = [];
  if (sysCh) {
    const msgs = (await dc.call("GET", `/channels/${sysCh}/messages?limit=50`)) || [];
    const waved = new Set(msgs.filter((m) => m.author.id === me.id && m.message_reference)
      .map((m) => m.message_reference.message_id));
    let newest = big(st.join_after);
    for (const m of msgs) if (big(m.id) > newest) newest = big(m.id);
    for (const m of [...msgs].sort(byId)) {
      if (m.type !== 7 || big(m.id) <= big(st.join_after) || waved.has(m.id)) continue;
      if (baseline || now - snowTime(m.id) > GREET_MAX_AGE) continue;
      // not bots (the bot's own join is one — it waved at itself once, 11-10) nor members who already left
      if (m.author.bot || !(await dc.isMember(gid, m.author.id))) {
        log("skip join", m.author.username);
        continue;
      }
      joins.push(m);
    }
    for (const m of joins) {
      const sticker = WAVE_STICKERS[Math.floor(Math.random() * WAVE_STICKERS.length)];
      log("wave", m.author.username, "sticker", sticker);
      if (dry) continue;
      try {
        await dc.call("POST", `/channels/${sysCh}/messages`, {
          sticker_ids: [sticker], message_reference: { message_id: m.id, fail_if_not_exists: false },
          allowed_mentions: { parse: [], replied_user: true },
        });
      } catch (e) {
        log("sticker failed:", e.message);
        await dc.call("PUT", `/channels/${sysCh}/messages/${m.id}/reactions/${encodeURIComponent("👋")}/@me`);
      }
    }
    st.join_after = newest.toString();
  }

  // ---------- 2. forum inbox ----------
  const notes = [];
  const active = ((await dc.call("GET", `/guilds/${gid}/threads/active`)) || {}).threads || [];
  for (const t of [...active].sort(byId)) {
    const label = forumIds[t.parent_id];
    if (label === undefined) continue;
    const tid = t.id;
    const last = t.last_message_id || tid;
    const seen = st.threads[tid];
    if (baseline) {
      st.threads[tid] = last;
      continue;
    }
    let after;
    if (seen === undefined) {
      // a post made since the last run (its first message has the thread's id), or an old archived post that came
      // back with a reply: only what was written since the last run
      after = big(tid) > prevSf ? big(tid) - 1n : prevSf;
    } else if (big(last) > big(seen)) {
      after = big(seen);
    } else {
      continue;
    }
    if (dc.count >= SUBREQ_BUDGET) {
      log("subrequest budget reached — the rest waits for the next run");
      break;
    }
    st.threads[tid] = last;
    let msgs = (await dc.call("GET", `/channels/${tid}/messages?after=${after}&limit=50`)) || [];
    msgs = msgs.filter((m) => !m.author.bot && m.author.id !== owner).sort(byId);
    if (!msgs.length) continue;
    const first = msgs[0];
    const name = first.author.global_name || first.author.username;
    const kind = seen === undefined && first.id === tid ? "새 글" : `새 댓글 ${msgs.length}`;
    const files = first.attachments && first.attachments.length ? ` (첨부 ${first.attachments.length})` : "";
    notes.push(`• [${label}] ${kind} — **${t.name.slice(0, 60)}** · ${name}: ${snippet(first.content)}${files}\n` +
      `  <https://discord.com/channels/${gid}/${tid}>`);
  }
  // archived threads stay in the state (a reply brings them back as active); forget ones quiet for 180 days
  for (const [k, v] of Object.entries(st.threads)) if (now - snowTime(v) > 180 * 86400) delete st.threads[k];

  if (joins.length) notes.push(`• 입장 인사 ${joins.length}명: ${joins.map((m) => m.author.username).join(", ")}`);
  if (notes.length && notify) {
    let text = `<@${owner}> 디스코드 새 소식\n${notes.join("\n")}`;
    if (text.length > MAX_NOTE) text = text.slice(0, MAX_NOTE) + "\n…";
    log("notify:\n" + text);
    if (!dry) await dc.call("POST", `/channels/${notify}/messages`, { content: text, allowed_mentions: { users: [owner] } });
  } else {
    log(baseline ? `baseline saved: ${Object.keys(st.threads).length} threads` : "nothing new");
  }
  st.last_run = new Date().toISOString();
  st.run_sf = runSf.toString();
  if (!dry) await env.STATE.put("state", JSON.stringify(st));
  log(`done (${dc.count} Discord calls${dry ? ", dry" : ""})`);
  return lines;
}

export default {
  async scheduled(event, env, ctx) {
    // awaited (not waitUntil) so a failure shows up as a failed cron run in the dashboard / `wrangler tail`
    try {
      await run(env);
    } catch (e) {
      console.error("run failed:", e && e.stack ? e.stack : e);
      throw e;
    }
  },

  // local test only (`wrangler dev --var LOCAL_RUN:1`): GET /run runs once and returns the log. The deployed worker
  // has no public URL (workers_dev = false) and no LOCAL_RUN, so this answers 404 there.
  async fetch(request, env) {
    if (String(env.LOCAL_RUN) !== "1" || new URL(request.url).pathname !== "/run") return new Response("not found", { status: 404 });
    try {
      return new Response((await run(env)).join("\n") + "\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    } catch (e) {
      return new Response("run failed: " + (e && e.stack ? e.stack : e) + "\n", { status: 500 });
    }
  },
};

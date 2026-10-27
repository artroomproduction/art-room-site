// Art-Room Production – site + comentarii la piese (cu aprobare)
import { DurableObject } from "cloudflare:workers";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const SONG_RE = /^[a-z0-9-]{1,40}$/;

export class CommentsStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL,
      created INTEGER NOT NULL, approved INTEGER NOT NULL DEFAULT 0, ip TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS visits (
      day TEXT NOT NULL, h TEXT NOT NULL, country TEXT, device TEXT, ref TEXT, views INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (day, h))`);
  }
  list(song) {
    return this.sql.exec(
      "SELECT id, name, text, created FROM comments WHERE song = ? AND approved = 1 ORDER BY created DESC LIMIT 200", song
    ).toArray();
  }
  add(song, name, text, ip) {
    const now = Date.now();
    const recent = this.sql.exec(
      "SELECT COUNT(*) AS n FROM comments WHERE ip = ? AND created > ?", ip, now - 10 * 60 * 1000
    ).one().n;
    if (recent >= 3) return { ok: false, error: "rate" };
    if (song === "recenzii") {
      const today = this.sql.exec(
        "SELECT COUNT(*) AS n FROM comments WHERE ip = ? AND song = 'recenzii' AND created > ?", ip, now - 24 * 60 * 60 * 1000
      ).one().n;
      if (today >= 1) return { ok: false, error: "rate-day" };
    }
    this.sql.exec("INSERT INTO comments (song, name, text, created, ip) VALUES (?, ?, ?, ?, ?)", song, name, text, now, ip);
    return { ok: true };
  }
  all() {
    return this.sql.exec(
      "SELECT id, song, name, text, created, approved FROM comments ORDER BY approved ASC, created DESC LIMIT 500"
    ).toArray();
  }
  hit(day, h, country, device, ref) {
    this.sql.exec(`INSERT INTO visits (day, h, country, device, ref) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(day, h) DO UPDATE SET views = views + 1`, day, h, country, device, ref);
    const cutoff = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
    this.sql.exec("DELETE FROM visits WHERE day < ?", cutoff);
    return { ok: true };
  }
  stats() {
    const today = new Date().toISOString().slice(0, 10);
    const since = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
    const one = (q, ...a) => this.sql.exec(q, ...a).one();
    const sum = (from) => one("SELECT COUNT(*) AS v, COALESCE(SUM(views),0) AS p FROM visits WHERE day >= ?", from);
    return {
      today: sum(today), week: sum(since(6)), month: sum(since(29)), total: sum("0000"),
      days: this.sql.exec("SELECT day, COUNT(*) AS v, SUM(views) AS p FROM visits WHERE day >= ? GROUP BY day ORDER BY day", since(29)).toArray(),
      countries: this.sql.exec("SELECT country AS k, COUNT(*) AS v FROM visits WHERE day >= ? GROUP BY country ORDER BY v DESC LIMIT 10", since(29)).toArray(),
      devices: this.sql.exec("SELECT device AS k, COUNT(*) AS v FROM visits WHERE day >= ? GROUP BY device ORDER BY v DESC", since(29)).toArray(),
      refs: this.sql.exec("SELECT ref AS k, COUNT(*) AS v FROM visits WHERE day >= ? GROUP BY ref ORDER BY v DESC LIMIT 10", since(29)).toArray(),
    };
  }
  approve(id) { this.sql.exec("UPDATE comments SET approved = 1 WHERE id = ?", id); return { ok: true }; }
  remove(id) { this.sql.exec("DELETE FROM comments WHERE id = ?", id); return { ok: true }; }
}

function clean(s, max) {
  return String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|lighthouse|headless|curl|wget|python|go-http/i;

async function track(request, store) {
  try {
    const ua = request.headers.get("user-agent") || "";
    if (!ua || BOT.test(ua)) return;
    const day = new Date().toISOString().slice(0, 10);
    const ip = request.headers.get("cf-connecting-ip") || "";
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(day + "|" + ip + "|" + ua));
    const h = [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
    const country = (request.cf && request.cf.country) || "?";
    const device = /iPad|Tablet/i.test(ua) ? "tabletă" : /Mobi|Android|iPhone/i.test(ua) ? "telefon" : "calculator";
    let ref = "direct";
    const r = request.headers.get("referer");
    if (r) { try { const host = new URL(r).hostname.replace(/^www\./, ""); if (!/artroomproduction\.ro$|workers\.dev$/.test(host)) ref = /facebook|fb\.|messenger/.test(host) ? "Facebook" : /instagram/.test(host) ? "Instagram" : /google\./.test(host) ? "Google" : /tiktok/.test(host) ? "TikTok" : /youtube/.test(host) ? "YouTube" : host; } catch {} }
    const q = new URL(request.url).searchParams;
    if (q.get("fbclid")) ref = "Facebook";
    await store.hit(day, h, country, device, ref);
  } catch {}
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const store = env.COMMENTS.get(env.COMMENTS.idFromName("main"));
    if (!url.pathname.startsWith("/api/")) {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) ctx.waitUntil(track(request, store));
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/comments" && request.method === "GET") {
      const song = url.searchParams.get("song") || "";
      if (!SONG_RE.test(song)) return json({ error: "song" }, 400);
      return json({ comments: await store.list(song) });
    }

    if (url.pathname === "/api/comments" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "body" }, 400); }
      if (body.website) return json({ ok: true }); // capcană pentru roboți
      const song = clean(body.song, 40);
      const name = clean(body.name, 40);
      const text = clean(body.text, 600);
      if (!SONG_RE.test(song) || name.length < 2 || text.length < 2) return json({ error: "invalid" }, 400);
      const ip = request.headers.get("cf-connecting-ip") || "?";
      const r = await store.add(song, name, text, ip);
      return json(r, r.ok ? 200 : 429);
    }

    if (url.pathname.startsWith("/api/admin/")) {
      const key = request.headers.get("x-admin-key") || "";
      if (!env.ADMIN_KEY) return json({ error: "no-key-configured" }, 503);
      if (key !== env.ADMIN_KEY) return json({ error: "auth" }, 401);
      if (url.pathname === "/api/admin/comments") return json({ comments: await store.all() });
      if (url.pathname === "/api/admin/stats") return json(await store.stats());
      if (request.method === "POST") {
        let body; try { body = await request.json(); } catch { return json({ error: "body" }, 400); }
        const id = Number(body.id);
        if (!Number.isInteger(id)) return json({ error: "id" }, 400);
        if (url.pathname === "/api/admin/approve") return json(await store.approve(id));
        if (url.pathname === "/api/admin/delete") return json(await store.remove(id));
      }
    }
    return json({ error: "not-found" }, 404);
  },
};

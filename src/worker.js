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
    this.sql.exec("INSERT INTO comments (song, name, text, created, ip) VALUES (?, ?, ?, ?, ?)", song, name, text, now, ip);
    return { ok: true };
  }
  all() {
    return this.sql.exec(
      "SELECT id, song, name, text, created, approved FROM comments ORDER BY approved ASC, created DESC LIMIT 500"
    ).toArray();
  }
  approve(id) { this.sql.exec("UPDATE comments SET approved = 1 WHERE id = ?", id); return { ok: true }; }
  remove(id) { this.sql.exec("DELETE FROM comments WHERE id = ?", id); return { ok: true }; }
}

function clean(s, max) {
  return String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const store = env.COMMENTS.get(env.COMMENTS.idFromName("main"));

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

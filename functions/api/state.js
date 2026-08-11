/* functions/api/state.js — Cloudflare Pages Function.
 *
 * This file's PATH is its route: because it lives at functions/api/state.js,
 * Cloudflare Pages automatically serves it at  /api/state  on your site's
 * own domain — no separate Worker, no wrangler, no terminal. It deploys
 * automatically every time the site deploys.
 *
 * Endpoints:
 *   GET    /api/state?id=default   -> { data: <saved JSON> | null }
 *   POST   /api/state              -> body: { id, data }  upserts the row
 *   DELETE /api/state?id=default   -> deletes the row
 *
 * Requires, set up entirely in the Cloudflare dashboard (no CLI):
 *   - A D1 database bound to this Pages project as  DB
 *     (Pages project -> Settings -> Functions -> D1 database bindings)
 *
 * No secret/auth check — this endpoint is open to anyone who can reach
 * your site's URL. Fine for a personal tool nobody else knows the URL of,
 * but be aware there's no gate on it.
 */

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (!env.DB) {
    return json(
      { error: "Server misconfigured: no D1 binding named DB on this Pages project." },
      500,
      corsHeaders
    );
  }

  const id = url.searchParams.get("id") || "default";

  try {
    if (request.method === "GET") {
      const row = await env.DB.prepare("SELECT data, updated_at FROM app_state WHERE id = ?")
        .bind(id)
        .first();
      if (!row) return json({ data: null }, 200, corsHeaders);
      return json({ data: JSON.parse(row.data), updated_at: row.updated_at }, 200, corsHeaders);
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "Invalid JSON body" }, 400, corsHeaders);
      }
      const recordId = body.id || id;
      if (body.data === undefined) {
        return json({ error: "Missing 'data' field" }, 400, corsHeaders);
      }
      const dataStr = JSON.stringify(body.data);
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO app_state (id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      )
        .bind(recordId, dataStr, now)
        .run();
      return json({ ok: true, updated_at: now }, 200, corsHeaders);
    }

    if (request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM app_state WHERE id = ?").bind(id).run();
      return json({ ok: true }, 200, corsHeaders);
    }

    return json({ error: "Method not allowed" }, 405, corsHeaders);
  } catch (e) {
    return json({ error: "Server error: " + e.message }, 500, corsHeaders);
  }
}

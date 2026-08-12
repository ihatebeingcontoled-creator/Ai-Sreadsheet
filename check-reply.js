/* functions/api/check-reply.js — Cloudflare Pages Function.
 *
 * Because it lives at functions/api/check-reply.js, Cloudflare Pages
 * automatically serves it at  /api/check-reply  on your site's own domain —
 * no separate Worker, no wrangler, no terminal. It deploys automatically
 * every time the site deploys.
 *
 * POST /api/check-reply
 * body: { threadId: "<gmail thread id>" }
 * -> { ok:true, hasReply:false }
 *      no message in the thread from anyone other than GMAIL_SENDER_EMAIL yet
 * -> { ok:true, hasReply:true, from, date, subject, text, messageId }
 *      the newest message in the thread that ISN'T from GMAIL_SENDER_EMAIL
 * -> { error: "..." }  (non-200) on failure
 *
 * How it works:
 *   Uses the same Gmail OAuth2 *refresh token* as send-email.js to mint a
 *   fresh access token, then calls the Gmail API's users.threads.get for
 *   the given thread id and walks its messages looking for the latest one
 *   that didn't come from GMAIL_SENDER_EMAIL (i.e. a reply from them, not
 *   another copy of something we sent).
 *
 * IMPORTANT — needs a wider scope than sending does:
 *   send-email.js only ever needed the gmail.send scope. Reading a thread's
 *   contents needs gmail.readonly too. If GMAIL_REFRESH_TOKEN was minted
 *   before this file existed, it almost certainly does NOT have that scope
 *   yet, and this endpoint will fail with an "insufficient authentication
 *   scopes" error from Google until you:
 *     1. Re-run `node get-gmail-refresh-token.mjs` locally (it now requests
 *        both gmail.send and gmail.readonly — see that file's SCOPE const)
 *     2. Approve the consent screen again (it'll now list "Read your email"
 *        as a second permission)
 *     3. Copy the NEW refresh token it prints and replace the
 *        GMAIL_REFRESH_TOKEN secret in Cloudflare Pages -> Settings ->
 *        Environment variables with it
 *   Same GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_SENDER_EMAIL as
 *   send-email.js — no new secrets to add, just the refreshed token.
 *
 * No auth check on who can call this endpoint itself — same posture as
 * /api/send-email and /api/state (fine for a personal tool nobody else
 * knows the URL of, but be aware there's no gate on it).
 */

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// --- base64url decoding (Workers runtime has no Buffer) ---
function base64UrlToUtf8(b64url) {
  if (!b64url) return "";
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "===".slice((b64.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Walks a Gmail message payload (which can nest multipart/alternative,
// multipart/mixed, multipart/related, etc.) looking for a text body.
// Prefers text/plain; falls back to text/html stripped down to text.
function extractBody(payload) {
  if (!payload) return "";

  let plain = "";
  let html = "";

  function walk(part) {
    if (!part) return;
    const mime = part.mimeType || "";
    if (mime === "text/plain" && part.body && part.body.data && !plain) {
      plain = base64UrlToUtf8(part.body.data);
    } else if (mime === "text/html" && part.body && part.body.data && !html) {
      html = base64UrlToUtf8(part.body.data);
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);

  if (plain.trim()) return plain.trim();
  if (html.trim()) return stripHtml(html);
  return "";
}

function getHeader(headers, name) {
  const h = (headers || []).find((h) => h.name && h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

// A reply's "quoted original" tail (everything from "On ... wrote:" or a
// line of dashes onward) is usually just the message we sent, echoed back —
// trim it off so the saved response text is just what they actually wrote.
function trimQuotedTail(text) {
  const patterns = [
    /\n\s*On .{0,120} wrote:\s*\n[\s\S]*$/i,
    /\n-{2,}\s*Original Message\s*-{2,}[\s\S]*$/i,
    /\n_{5,}[\s\S]*$/,
  ];
  let out = text;
  for (const re of patterns) {
    const m = out.match(re);
    if (m) out = out.slice(0, m.index);
  }
  return out.trim();
}

async function getAccessToken(env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`Couldn't refresh Gmail access token: ${detail}`);
  }
  return data.access_token;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const missing = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "GMAIL_SENDER_EMAIL"].filter(
    (k) => !env[k]
  );
  if (missing.length) {
    return json(
      { error: `Server misconfigured: missing Cloudflare env var(s): ${missing.join(", ")}` },
      500,
      corsHeaders
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const threadId = (body.threadId || "").trim();
  if (!threadId) return json({ error: "Missing 'threadId'" }, 400, corsHeaders);

  try {
    const accessToken = await getAccessToken(env);

    const threadRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const threadData = await threadRes.json().catch(() => ({}));

    if (!threadRes.ok) {
      const msg = (threadData.error && threadData.error.message) || JSON.stringify(threadData);
      const scopeHint =
        threadRes.status === 403 || /insufficient/i.test(msg)
          ? " — this almost always means GMAIL_REFRESH_TOKEN was minted before gmail.readonly was added; see the comment at the top of check-reply.js for how to fix it."
          : "";
      return json({ error: `Gmail API error ${threadRes.status}: ${msg}${scopeHint}` }, 502, corsHeaders);
    }

    const messages = threadData.messages || [];
    const senderEmail = (env.GMAIL_SENDER_EMAIL || "").toLowerCase();

    // Walk from newest to oldest looking for a message that ISN'T from us.
    let replyMsg = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const from = getHeader(messages[i].payload && messages[i].payload.headers, "From").toLowerCase();
      if (from && !from.includes(senderEmail)) {
        replyMsg = messages[i];
        break;
      }
    }

    if (!replyMsg) {
      return json({ ok: true, hasReply: false }, 200, corsHeaders);
    }

    const headers = replyMsg.payload && replyMsg.payload.headers;
    const from = getHeader(headers, "From");
    const date = getHeader(headers, "Date");
    const subject = getHeader(headers, "Subject");
    const rawText = extractBody(replyMsg.payload) || replyMsg.snippet || "";
    const text = trimQuotedTail(rawText);

    return json(
      { ok: true, hasReply: true, from, date, subject, text, messageId: replyMsg.id },
      200,
      corsHeaders
    );
  } catch (e) {
    return json({ error: e.message || "Server error checking for reply" }, 500, corsHeaders);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders });
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  if (context.request.method === "OPTIONS") return onRequestOptions();
  return json({ error: "Method not allowed" }, 405, corsHeaders);
}

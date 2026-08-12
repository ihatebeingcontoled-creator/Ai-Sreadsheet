/* functions/api/send-email.js — Cloudflare Pages Function.
 *
 * Because it lives at functions/api/send-email.js, Cloudflare Pages
 * automatically serves it at  /api/send-email  on your site's own domain —
 * no separate Worker, no wrangler, no terminal. It deploys automatically
 * every time the site deploys.
 *
 * POST /api/send-email
 * body: { to: "someone@example.com", subject: "...", text: "..." }
 * -> { ok: true, id: "<gmail message id>", threadId: "<gmail thread id>", from: "<GMAIL_SENDER_EMAIL>" }  on success
 * -> { error: "..." }  (non-200) on failure
 *
 * `from` is just GMAIL_SENDER_EMAIL echoed back \u2014 not a secret, it's already
 * visible in the From header of every email this sends. It's currently
 * unused by index.html (Gmail doesn't reliably resolve /u/<email>/ the way
 * /u/<N>/ does, so the Response-link building there uses a plain numeric
 * "Gmail slot" setting instead \u2014 see state.gmailAccountSlot / the header
 * input in index.html). Kept here in case that changes.
 *
 * How it sends the email:
 *   Uses a Gmail account's OAuth2 *refresh token* (minted once, offline —
 *   see get-gmail-refresh-token.mjs in the repo root) to mint a fresh
 *   access token on every call, then calls the Gmail API's
 *   users.messages.send with a base64url-encoded RFC 2822 message.
 *
 * Requires these set as environment variables / secrets on this Cloudflare
 * Pages project (Pages project -> Settings -> Environment variables —
 * add each as type "Secret", not "Plaintext", since they're credentials):
 *
 *   GMAIL_CLIENT_ID       - from Google Cloud OAuth client (credentials.json "client_id")
 *   GMAIL_CLIENT_SECRET   - from Google Cloud OAuth client (credentials.json "client_secret")
 *   GMAIL_REFRESH_TOKEN   - minted once by running get-gmail-refresh-token.mjs locally
 *   GMAIL_SENDER_EMAIL    - the Gmail address these emails are sent FROM
 *                           (must be the same account you authorized in that script)
 *   GMAIL_SENDER_NAME     - optional display name, e.g. "Ben @ AI Widgets"
 *
 * No auth check on who can call this endpoint itself — same posture as
 * /api/state (fine for a personal tool nobody else knows the URL of, but
 * be aware there's no gate on it; anyone who finds the URL could make it
 * send email as you).
 */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- small base64/base64url + UTF-8 helpers (Workers runtime has no Buffer) ---

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function toBase64Url(b64) {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// wraps a base64 string at 76 chars per line, per MIME convention
function wrapBase64(b64) {
  return b64.replace(/(.{76})/g, "$1\r\n");
}

// RFC 2047-encodes a header value if it contains non-ASCII characters
// (needed for Lithuanian subject lines with ą/č/ę/ė/į/š/ų/ū/ž etc.)
function encodeHeader(str) {
  if (/^[\x00-\x7F]*$/.test(str)) return str;
  return `=?UTF-8?B?${utf8ToBase64(str)}?=`;
}

function buildRawMessage({ to, from, fromName, subject, text }) {
  const fromHeader = fromName ? `${encodeHeader(fromName)} <${from}>` : from;
  const headers =
    `To: ${to}\r\n` +
    `From: ${fromHeader}\r\n` +
    `Subject: ${encodeHeader(subject || "(no subject)")}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset="UTF-8"\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n`;
  const body = wrapBase64(utf8ToBase64(text || ""));
  return headers + body;
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
      500
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const to = (body.to || "").trim();
  const subject = body.subject || "";
  const text = body.text || "";
  if (!to) return json({ error: "Missing 'to' address" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json({ error: `"${to}" doesn't look like a valid email address` }, 400);

  try {
    const accessToken = await getAccessToken(env);

    const raw = buildRawMessage({
      to,
      from: env.GMAIL_SENDER_EMAIL,
      fromName: env.GMAIL_SENDER_NAME || "",
      subject,
      text,
    });
    const rawBase64Url = toBase64Url(utf8ToBase64(raw));

    const sendRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: rawBase64Url }),
    });
    const sendData = await sendRes.json().catch(() => ({}));

    if (!sendRes.ok) {
      const detail = (sendData.error && sendData.error.message) || JSON.stringify(sendData);
      return json({ error: `Gmail API error ${sendRes.status}: ${detail}` }, 502);
    }

    return json({ ok: true, id: sendData.id, threadId: sendData.threadId, from: env.GMAIL_SENDER_EMAIL }, 200);
  } catch (e) {
    return json({ error: e.message || "Server error sending email" }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  if (context.request.method === "OPTIONS") return onRequestOptions();
  return json({ error: "Method not allowed" }, 405);
}

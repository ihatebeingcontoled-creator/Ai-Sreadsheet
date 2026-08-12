/* email.js — real email sending for the Outreach Ledger.
 *
 * Sending an actual email requires a secret (Gmail's OAuth client secret)
 * that must never sit in browser-side code, so this file does NOT talk to
 * Gmail directly. It just POSTs { to, subject, text } to this site's own
 * /api/send-email endpoint (functions/api/send-email.js), which is a
 * Cloudflare Pages Function running server-side. That function holds the
 * Gmail credentials (as Cloudflare secrets) and does the real Gmail API
 * call.
 *
 * window.EmailSender.sendEmail({ to, subject, text }) -> Promise<{ ok:true, id, threadId, from }>
 * `threadId` is Gmail's thread id for the sent message \u2014 index.html uses it
 * (combined with the "Gmail slot (u/N)" setting in the header) to build a
 * direct link to the thread in Gmail for the Response modal's link.
 * Rejects with a readable Error on failure (missing recipient, network
 * error, Gmail API error, or the backend not being set up yet).
 */
(function () {
  const ENDPOINT = "/api/send-email";

  async function sendEmail({ to, subject, text }) {
    if (!to || !to.trim()) {
      throw new Error("No recipient address on file.");
    }

    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: to.trim(), subject: subject || "", text: text || "" }),
      });
    } catch (networkErr) {
      throw new Error("Network error reaching /api/send-email: " + networkErr.message);
    }

    const rawText = await res.text().catch(() => "");
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch (e) {
      // not JSON — fall through, handled below
    }

    if (!res.ok) {
      const detail = (data && data.error) || rawText || `HTTP ${res.status} ${res.statusText}`;
      throw new Error(detail);
    }
    if (!data || !data.ok) {
      throw new Error((data && data.error) || "Gmail send failed for an unknown reason.");
    }
    return data;
  }

  window.EmailSender = { sendEmail };
})();

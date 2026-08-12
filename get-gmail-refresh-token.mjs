/* get-gmail-refresh-token.mjs — run this ONCE, locally, on your own machine.
 *
 * It never touches Cloudflare or the deployed site. All it does is:
 *   1. Read credentials.json (the file you downloaded from Google Cloud)
 *   2. Open a login/consent URL for you to approve in your browser
 *   3. Catch the redirect on http://localhost:3000/oauth2callback
 *   4. Exchange the code Google sends back for a REFRESH TOKEN
 *   5. Print that refresh token so you can paste it into Cloudflare
 *
 * Requirements:
 *   - Node.js 18+ (for built-in fetch)
 *   - credentials.json sitting in the same folder as this script
 *   - In Google Cloud Console (project from credentials.json):
 *       - Gmail API enabled (APIs & Services -> Library -> Gmail API -> Enable)
 *       - OAuth consent screen set to "Testing" with YOUR Gmail address
 *         added under "Test users" (External apps in testing mode only
 *         work for accounts explicitly added there)
 *       - The OAuth client's "Authorized redirect URIs" must include
 *         exactly:  http://localhost:3000/oauth2callback
 *         (this already matches the redirect_uris in your credentials.json)
 *
 * Run it with:
 *   node get-gmail-refresh-token.mjs
 *
 * Then open the printed URL, sign in with the Gmail account you want to
 * SEND FROM, and approve. The script does the rest and prints your
 * refresh token — copy that into Cloudflare as GMAIL_REFRESH_TOKEN (see
 * README-EMAIL-SETUP.md).
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
// gmail.send lets the site send email (functions/api/send-email.js).
// gmail.readonly lets it read a thread's messages back (functions/api/
// check-reply.js), which is what makes the Response tab able to pull in an
// actual reply instead of just linking out to Gmail. If you already have a
// GMAIL_REFRESH_TOKEN from before check-reply.js existed, it only has
// gmail.send — you need to re-run this script and swap in the new token
// (see README-EMAIL-SETUP.md / the comment atop check-reply.js).
const SCOPE = "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly";

let creds;
try {
  const raw = readFileSync(new URL("./credentials.json", import.meta.url), "utf8");
  creds = JSON.parse(raw).web;
} catch (e) {
  console.error("Couldn't read credentials.json in this folder:", e.message);
  process.exit(1);
}

if (!creds.redirect_uris || !creds.redirect_uris.includes(REDIRECT_URI)) {
  console.warn(
    `Warning: credentials.json's redirect_uris doesn't list ${REDIRECT_URI}. ` +
      `Add it in Google Cloud Console -> Credentials -> your OAuth client -> Authorized redirect URIs, ` +
      `or this will fail with redirect_uri_mismatch.`
  );
}

const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth?` +
  new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline", // required to get a refresh_token back
    prompt: "consent", // forces a refresh_token even if you've authorized before
  }).toString();

console.log("\nOpen this URL, sign in with the Gmail account you want to send FROM, and approve:\n");
console.log(authUrl + "\n");
console.log(`Waiting for the redirect on ${REDIRECT_URI} ...\n`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/oauth2callback") {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get("code");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    res.writeHead(200, { "Content-Type": "text/html" }).end(`<h2>Error: ${errorParam}</h2>You can close this tab.`);
    console.error("Google returned an error:", errorParam);
    server.close();
    process.exit(1);
  }

  try {
    const tokenRes = await fetch(creds.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.refresh_token) {
      res.writeHead(200, { "Content-Type": "text/html" }).end(
        `<h2>Didn't get a refresh token.</h2><pre>${JSON.stringify(tokenData, null, 2)}</pre>You can close this tab.`
      );
      console.error(
        "\nNo refresh_token in the response. Common cause: you've already authorized this app before " +
          "without revoking it. Fix: go to https://myaccount.google.com/permissions, remove access for " +
          "this app, then run this script again.\n"
      );
      console.error(JSON.stringify(tokenData, null, 2));
      server.close();
      process.exit(1);
    }

    res.writeHead(200, { "Content-Type": "text/html" }).end(
      "<h2>Success! You can close this tab and go back to the terminal.</h2>"
    );

    console.log("\n=== Success ===\n");
    console.log("GMAIL_REFRESH_TOKEN:", tokenData.refresh_token);
    console.log("\nCopy that value into Cloudflare Pages -> your project -> Settings -> Environment variables");
    console.log("as a SECRET named GMAIL_REFRESH_TOKEN. See README-EMAIL-SETUP.md for the other variables needed.\n");
  } catch (e) {
    console.error("Token exchange failed:", e.message);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT);

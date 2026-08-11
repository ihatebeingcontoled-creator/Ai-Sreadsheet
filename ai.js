/* ai.js — real AI integration for the Outreach Ledger.
 *
 * Right now this powers "Fetch Info" / "Generate Info" / the Info step of
 * "Automate": it calls Groq's `groq/compound` model, which has a *built-in*
 * web-search tool, so it actually looks the company up instead of returning
 * canned text.
 *
 * compound_custom.tools.enabled_tools is set to just ["web_search"] below —
 * by default compound can also reach for code execution, visiting websites,
 * and Wolfram Alpha in the same call, and that extra tool orchestration was
 * causing Groq to reject even tiny prompts with a 413. Restricting it to
 * search-only keeps the real web lookup this app needs while avoiding that.
 *
 * The Groq API key itself is managed by apikeys.js (top-right status bar —
 * the "🔍 Info" pill). It's stored only in this browser's localStorage and
 * sent only to api.groq.com — never anywhere else.
 *
 * Everything else in index.html talks to this file through one global:
 *   window.AI.fetchCompanyInfo(companyName) -> Promise<string>
 */

(function () {
  const SERVICE_ID = "info";
  const GROQ_MODEL = "groq/compound-mini"; // has built-in web search, so it can research a real company
  const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

  function isConfigured() {
    return !!(window.APIKeys && window.APIKeys.hasActiveKey(SERVICE_ID));
  }

  async function fetchCompanyInfo(companyName) {
    const key = window.APIKeys ? window.APIKeys.getActiveKey(SERVICE_ID) : "";
    if (!key) {
      if (window.APIKeys) window.APIKeys.openManager(SERVICE_ID);
      throw new Error(
        "No Info Research API key set yet. Click the \uD83D\uDD0D Info button (top right) to add one."
      );
    }

    const prompt =
      `Research the real company/business named "${companyName}". Use web search to find out ` +
      `what they actually do. Reply in short plain-text lines (no markdown symbols) labeled: ` +
      `Overview, Key products/services, Target market, Competitors, Recent news. ` +
      `If you can't find a real business by this name, say so plainly instead of inventing details.`;

    let res;
    try {
      res = await fetch(GROQ_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [{ role: "user", content: prompt }],
          // NOTE: compound_custom.tools.enabled_tools was tried here to restrict
          // compound to web_search only, but it produced a different, stranger
          // error ("Unknown request URL: GET ...") — pulled back out so we can
          // test compound-mini in isolation before reintroducing it.
        }),
      });
    } catch (networkErr) {
      throw new Error("Network error reaching Groq: " + networkErr.message);
    }

    if (!res.ok) {
      let detail = "";
      try {
        const errJson = await res.json();
        detail = (errJson.error && errJson.error.message) || JSON.stringify(errJson);
      } catch (e) {
        detail = await res.text().catch(() => "");
      }
      if (res.status === 401) {
        throw new Error(
          "Groq rejected the API key (401). Click the \uD83D\uDD0D Info button (top right) to check or switch it."
        );
      }
      if (res.status === 413) {
        throw new Error(
          "Groq rejected the request as too large (413). This is a known issue with the groq/compound model " +
            "on some queries \u2014 not your API key. Try again; if it keeps happening, it may be worth switching " +
            "GROQ_MODEL to \"groq/compound-mini\" in ai.js."
        );
      }
      throw new Error(`Groq API error ${res.status}: ${detail || "request failed"}`);
    }

    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error("Groq returned an empty response.");
    return text.trim();
  }

  window.AI = { isConfigured, fetchCompanyInfo };
})();

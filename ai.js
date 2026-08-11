/* ai.js — real AI integration for the Outreach Ledger.
 *
 * Right now this powers "Fetch Info" / "Generate Info" / the Info step of
 * "Automate": it calls Groq's `groq/compound` model, which has a *built-in*
 * web-search tool, so it actually looks the company up instead of returning
 * canned text.
 *
 * You bring your own free Groq API key (console.groq.com/keys). It's stored
 * only in this browser's localStorage and sent only to api.groq.com — never
 * anywhere else. Click the "⚙️ AI Key" button (top right) to set it.
 *
 * Everything else in index.html talks to this file through one global:
 *   window.AI.fetchCompanyInfo(companyName) -> Promise<string>
 */

(function () {
  const GROQ_KEY_STORAGE = "outreachLedger_groqApiKey";
  const GROQ_MODEL = "groq/compound"; // has built-in web search, so it can research a real company
  const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

  function getKey() {
    return localStorage.getItem(GROQ_KEY_STORAGE) || "";
  }
  function setKey(key) {
    if (key) localStorage.setItem(GROQ_KEY_STORAGE, key.trim());
    else localStorage.removeItem(GROQ_KEY_STORAGE);
  }
  function isConfigured() {
    return !!getKey();
  }

  async function fetchCompanyInfo(companyName) {
    const key = getKey();
    if (!key) {
      openSettings();
      throw new Error(
        "No Groq API key set yet. Click the \u2699\ufe0f AI Key button (top right) to add one."
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
        throw new Error("Groq rejected the API key (401). Check it in \u2699\ufe0f AI Key.");
      }
      throw new Error(`Groq API error ${res.status}: ${detail || "request failed"}`);
    }

    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error("Groq returned an empty response.");
    return text.trim();
  }

  /* ---------- tiny self-contained settings popup, so index.html needs no new markup ---------- */
  function ensureUI() {
    if (document.getElementById("aiKeyBtn")) return;

    const btn = document.createElement("button");
    btn.id = "aiKeyBtn";
    btn.textContent = isConfigured() ? "\u2699\ufe0f AI Key \u2713" : "\u2699\ufe0f AI Key";
    btn.style.cssText = `
      position:fixed; top:14px; right:14px; z-index:999;
      font-family:'IBM Plex Mono', monospace; font-size:11px;
      background:rgba(90,143,214,.14); color:#5a8fd6; border:1px solid rgba(90,143,214,.3);
      padding:6px 12px; border-radius:20px; cursor:pointer;
    `;
    btn.onclick = openSettings;
    document.body.appendChild(btn);

    const overlay = document.createElement("div");
    overlay.id = "aiKeyOverlay";
    overlay.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:1000;
      display:none; align-items:center; justify-content:center; padding:20px;
    `;
    overlay.innerHTML = `
      <div style="background:#1c2024; border:1px solid #3a4148; border-radius:10px; padding:20px; width:100%; max-width:380px; font-family:'IBM Plex Mono', monospace; color:#e9e6e0;">
        <div style="font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:15px; margin-bottom:4px;">Groq API Key</div>
        <div style="font-size:11.5px; color:#98a0a7; margin-bottom:12px; line-height:1.5;">
          Powers "Fetch Info" / "Generate Info" with real web search. Stored only in this
          browser (localStorage) \u2014 never sent anywhere but Groq's API. Free key at
          <a href="https://console.groq.com/keys" target="_blank" rel="noopener" style="color:#5a8fd6;">console.groq.com/keys</a>.
        </div>
        <input id="aiKeyInput" type="password" placeholder="gsk_..." autocomplete="off" style="
          width:100%; background:#14171a; border:1px solid #3a4148; color:#e9e6e0;
          font-family:'IBM Plex Mono', monospace; font-size:12.5px; padding:8px 10px; border-radius:6px; box-sizing:border-box;
        "/>
        <div style="display:flex; gap:8px; margin-top:12px; align-items:center; justify-content:flex-end;">
          <button id="aiKeyClear" style="background:none; border:none; color:#5f6870; font-size:11px; text-decoration:underline; cursor:pointer; margin-right:auto;">Clear key</button>
          <button id="aiKeyCancel" style="background:transparent; border:1px solid #3a4148; color:#e9e6e0; font-size:12.5px; padding:7px 14px; border-radius:6px; cursor:pointer;">Cancel</button>
          <button id="aiKeySave" style="background:rgba(95,174,123,.14); border:1px solid rgba(95,174,123,.3); color:#5fae7b; font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:12.5px; padding:7px 14px; border-radius:6px; cursor:pointer;">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeSettings();
    });
    overlay.querySelector("#aiKeyCancel").onclick = closeSettings;
    overlay.querySelector("#aiKeySave").onclick = () => {
      const val = overlay.querySelector("#aiKeyInput").value.trim();
      setKey(val);
      btn.textContent = isConfigured() ? "\u2699\ufe0f AI Key \u2713" : "\u2699\ufe0f AI Key";
      closeSettings();
    };
    overlay.querySelector("#aiKeyClear").onclick = () => {
      setKey("");
      overlay.querySelector("#aiKeyInput").value = "";
      btn.textContent = "\u2699\ufe0f AI Key";
    };
  }

  function openSettings() {
    ensureUI();
    document.getElementById("aiKeyInput").value = getKey();
    document.getElementById("aiKeyOverlay").style.display = "flex";
  }
  function closeSettings() {
    const overlay = document.getElementById("aiKeyOverlay");
    if (overlay) overlay.style.display = "none";
  }

  if (document.readyState !== "loading") ensureUI();
  else document.addEventListener("DOMContentLoaded", ensureUI);

  window.AI = { getKey, setKey, isConfigured, fetchCompanyInfo, openSettings };
})();

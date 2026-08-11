/* safe-send.js — safety net for testing real sends on the Outreach Ledger.
 *
 * Adds a bar at the VERY top of the page (above the wood frame-bar and the
 * header) that reads "Send Real Messages" with a toggle switch, plus a
 * gear (settings) icon next to it.
 *
 * Click the gear -> a panel titled "Replace your messages to" where you can
 * set a preset email address and a preset phone number.
 *
 * How the redirect works:
 *   - Leave the "Send Real Messages" toggle OFF (the default): every real
 *     send (Email today, via /api/send-email — iMessage/Viber/Calls
 *     whenever those get wired to a real provider) goes to the PRESET
 *     email/number you set in the gear panel, no matter what's actually on
 *     file for that company. This is the safe mode for testing — put your
 *     own email/number in there and everything lands on you instead of a
 *     real business.
 *   - Once a company has a real email/number on file (after Fetch Info,
 *     Fetch Email, or Fetch Number), a "Use real email" / "Use real
 *     number" button appears next to that company's Fetch button. Click it
 *     to let THAT ONE company send to its real, fetched contact info
 *     instead of the preset. Every other company keeps going to the preset
 *     until you flip theirs too.
 *   - Flip the top toggle to ON and nothing is redirected at all — every
 *     company sends to its real contact info, presets and per-company
 *     flags are ignored. This is "actually go live."
 *   - If you never set a preset email/number in the gear panel, this whole
 *     thing is a no-op — sends go to the real address/number exactly like
 *     before.
 *
 * Everything here (toggle, presets, per-company "use real" flags) is
 * stored only in this browser's localStorage — like apikeys.js, it's a
 * local safety setting, not app data, so it does NOT round-trip through
 * /api/state or D1. It won't follow you to a different browser/device.
 *
 * Other scripts read this through:
 *   window.SafeSend.resolveAddress(companyId, realEmail)  -> string actually used to send
 *   window.SafeSend.resolveNumber(companyId, realNumber)  -> string actually used to send
 *   window.SafeSend.emailBtnHtml(companyId, realEmail)    -> "" or a <button> string
 *   window.SafeSend.numberBtnHtml(companyId, realNumber)  -> "" or a <button> string
 *   window.SafeSend.toggleRealEmail(companyId)
 *   window.SafeSend.toggleRealNumber(companyId)
 */
(function () {
  const STORE_KEY = "outreachLedger_safeSend_v1";

  function defaultStore() {
    return { enabled: false, presetEmail: "", presetPhone: "", useRealEmail: {}, useRealNumber: {} };
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultStore();
      const parsed = JSON.parse(raw);
      return Object.assign(defaultStore(), parsed, {
        useRealEmail: (parsed && parsed.useRealEmail) || {},
        useRealNumber: (parsed && parsed.useRealNumber) || {},
      });
    } catch (e) {
      return defaultStore();
    }
  }

  function saveStore() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch (e) {
      console.error("Could not save Send Real Messages settings:", e);
    }
  }

  let store = loadStore();

  function rerenderApp() {
    // re-render the ledger table so per-company buttons reflect the new state
    if (typeof window.render === "function") window.render();
  }

  /* ---------- resolution: what address/number does a real send actually use ---------- */

  function resolveAddress(companyId, realEmail) {
    if (store.enabled) return realEmail;
    const preset = (store.presetEmail || "").trim();
    if (!preset) return realEmail;
    if (store.useRealEmail[companyId]) return realEmail;
    return preset;
  }

  function resolveNumber(companyId, realNumber) {
    if (store.enabled) return realNumber;
    const preset = (store.presetPhone || "").trim();
    if (!preset) return realNumber;
    if (store.useRealNumber[companyId]) return realNumber;
    return preset;
  }

  function isRedirectingEmail(companyId) {
    return !store.enabled && !!(store.presetEmail || "").trim() && !store.useRealEmail[companyId];
  }
  function isRedirectingNumber(companyId) {
    return !store.enabled && !!(store.presetPhone || "").trim() && !store.useRealNumber[companyId];
  }

  function toggleRealEmail(companyId) {
    store.useRealEmail[companyId] = !store.useRealEmail[companyId];
    saveStore();
    rerenderApp();
  }
  function toggleRealNumber(companyId) {
    store.useRealNumber[companyId] = !store.useRealNumber[companyId];
    saveStore();
    rerenderApp();
  }

  /* ---------- per-company "Use real email/number" buttons, inlined into the ledger row ---------- */

  function escAttr(s) {
    return String(s || "").replace(/"/g, "&quot;");
  }

  function emailBtnHtml(companyId, realEmail) {
    if (store.enabled) return ""; // nothing is being redirected — no button needed
    if (!(store.presetEmail || "").trim()) return ""; // no preset set — nothing to opt out of
    if (!realEmail || !realEmail.trim()) return ""; // nothing real fetched yet for this company
    const usingReal = !!store.useRealEmail[companyId];
    const label = usingReal ? "\u2705 Using Real Email" : "\u2611\uFE0F Use Real Email";
    const title = usingReal
      ? `Sending here for real, to ${escAttr(realEmail)}. Click to go back to the preset.`
      : `Currently redirected to the preset (${escAttr(store.presetEmail)}). Click to actually send to ${escAttr(realEmail)}.`;
    return `<button class="info-action-btn" style="width:100%; text-align:center; margin-top:6px; ${usingReal ? "color:#5fae7b; border-color:rgba(95,174,123,.35);" : "color:#d9a441; border-color:rgba(217,164,65,.35);"}" onclick="SafeSend.toggleRealEmail('${companyId}')" title="${title}">${label}</button>`;
  }

  function numberBtnHtml(companyId, realNumber) {
    if (store.enabled) return "";
    if (!(store.presetPhone || "").trim()) return "";
    if (!realNumber || !realNumber.trim()) return "";
    const usingReal = !!store.useRealNumber[companyId];
    const label = usingReal ? "\u2705 Using Real Number" : "\u2611\uFE0F Use Real Number";
    const title = usingReal
      ? `Sending here for real, to ${escAttr(realNumber)}. Click to go back to the preset.`
      : `Currently redirected to the preset (${escAttr(store.presetPhone)}). Click to actually send to ${escAttr(realNumber)}.`;
    return `<button class="info-action-btn" style="width:100%; text-align:center; margin-top:6px; ${usingReal ? "color:#5fae7b; border-color:rgba(95,174,123,.35);" : "color:#d9a441; border-color:rgba(217,164,65,.35);"}" onclick="SafeSend.toggleRealNumber('${companyId}')" title="${title}">${label}</button>`;
  }

  /* ---------- top bar: "Send Real Messages" toggle + gear ---------- */

  function ensureBar() {
    if (document.getElementById("safeSendBar")) return;
    const bar = document.createElement("div");
    bar.id = "safeSendBar";
    bar.style.cssText = `
      display:flex; align-items:center; justify-content:center; gap:10px;
      padding:8px 14px; font-family:'IBM Plex Mono', monospace; font-size:12.5px;
      background:#14171a; border-bottom:1px solid #3a4148; color:#98a0a7;
    `;
    document.body.insertBefore(bar, document.body.firstChild);
    renderBar();
  }

  function renderBar() {
    const bar = document.getElementById("safeSendBar");
    if (!bar) return;
    const redirectActive = !store.enabled && (!!(store.presetEmail || "").trim() || !!(store.presetPhone || "").trim());

    bar.innerHTML = `
      <span style="font-weight:600; letter-spacing:.02em; color:${store.enabled ? "#d9645b" : "#e9e6e0"};">
        ${store.enabled ? "\u26A0\uFE0F" : "\uD83D\uDEE1\uFE0F"} Send Real Messages
      </span>
      <button id="safeSendToggle" type="button" title="${store.enabled ? "ON \u2014 everything sends to real contact info" : "OFF \u2014 sends are redirected to your presets, see the gear icon"}" style="
        position:relative; width:38px; height:21px; border-radius:12px; border:1px solid #3a4148; cursor:pointer;
        background:${store.enabled ? "#5fae7b" : "#2b3137"}; padding:0; flex-shrink:0;
      ">
        <span style="
          position:absolute; top:1px; left:${store.enabled ? "18px" : "1px"}; width:17px; height:17px; border-radius:50%;
          background:#e9e6e0; transition:left .15s;
        "></span>
      </button>
      <span style="font-size:11px; color:${redirectActive ? "#d9a441" : "#5f6870"}; white-space:nowrap;">
        ${store.enabled ? "live \u2014 no redirect" : redirectActive ? "redirecting to presets" : "no presets set"}
      </span>
      <button id="safeSendGearBtn" type="button" title="Set the preset email/number sends get redirected to" style="
        background:none; border:1px solid #3a4148; color:#98a0a7; font-size:14px; line-height:1;
        width:26px; height:26px; border-radius:50%; cursor:pointer; flex-shrink:0;
      ">\u2699\uFE0F</button>
    `;
    bar.querySelector("#safeSendToggle").onclick = () => {
      store.enabled = !store.enabled;
      saveStore();
      renderBar();
      rerenderApp();
    };
    bar.querySelector("#safeSendGearBtn").onclick = openSettings;
  }

  /* ---------- settings modal: "Replace your messages to" ---------- */

  function ensureModal() {
    if (document.getElementById("safeSendOverlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "safeSendOverlay";
    overlay.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:1000;
      display:none; align-items:center; justify-content:center; padding:20px;
    `;
    overlay.innerHTML = `
      <div style="background:#1c2024; border:1px solid #3a4148; border-radius:12px; padding:24px; width:100%; max-width:440px; font-family:'IBM Plex Mono', monospace; color:#e9e6e0;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
          <div style="font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:18px;">Replace your messages to</div>
          <button id="safeSendCloseX" style="background:none; border:none; color:#98a0a7; font-size:20px; cursor:pointer;">\u2715</button>
        </div>
        <div style="font-size:13px; color:#98a0a7; margin-bottom:18px; line-height:1.55;">
          While "Send Real Messages" is OFF, every real send is redirected here, no matter what's actually on file for a company. Put your own email/number in so you can test the whole flow safely. Leave a field blank to not redirect that channel at all.
        </div>

        <div style="font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:#5f6870; margin-bottom:6px;">Preset email (Email channel)</div>
        <input id="safeSendEmailInput" type="email" placeholder="you@example.com" autocomplete="off" style="
          width:100%; background:#14171a; border:1px solid #3a4148; color:#e9e6e0;
          font-family:'IBM Plex Mono', monospace; font-size:14.5px; padding:11px 13px; border-radius:8px; box-sizing:border-box; margin-bottom:14px;
        "/>

        <div style="font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:#5f6870; margin-bottom:6px;">Preset phone number (iMessage / Viber / SMS)</div>
        <input id="safeSendPhoneInput" type="text" placeholder="+370..." autocomplete="off" style="
          width:100%; background:#14171a; border:1px solid #3a4148; color:#e9e6e0;
          font-family:'IBM Plex Mono', monospace; font-size:14.5px; padding:11px 13px; border-radius:8px; box-sizing:border-box;
        "/>

        <div style="font-size:11.5px; color:#5f6870; margin-top:14px; line-height:1.5;">
          Once a company has a real email/number on file, a "Use Real Email" / "Use Real Number" button shows up next to it in the ledger \u2014 click it to let that one company through to its real contact info instead of the preset above.
        </div>

        <div style="display:flex; justify-content:flex-end; margin-top:16px;">
          <button id="safeSendSaveBtn" style="background:rgba(95,174,123,.14); border:1px solid rgba(95,174,123,.3); color:#5fae7b; font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:14.5px; padding:10px 20px; border-radius:8px; cursor:pointer;">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeSettings();
    });
    overlay.querySelector("#safeSendCloseX").onclick = closeSettings;
    overlay.querySelector("#safeSendSaveBtn").onclick = () => {
      store.presetEmail = document.getElementById("safeSendEmailInput").value.trim();
      store.presetPhone = document.getElementById("safeSendPhoneInput").value.trim();
      saveStore();
      renderBar();
      rerenderApp();
      closeSettings();
    };
  }

  function openSettings() {
    ensureModal();
    document.getElementById("safeSendEmailInput").value = store.presetEmail || "";
    document.getElementById("safeSendPhoneInput").value = store.presetPhone || "";
    document.getElementById("safeSendOverlay").style.display = "flex";
  }
  function closeSettings() {
    const overlay = document.getElementById("safeSendOverlay");
    if (overlay) overlay.style.display = "none";
  }

  if (document.readyState !== "loading") ensureBar();
  else document.addEventListener("DOMContentLoaded", ensureBar);

  window.SafeSend = {
    resolveAddress,
    resolveNumber,
    isRedirectingEmail,
    isRedirectingNumber,
    toggleRealEmail,
    toggleRealNumber,
    emailBtnHtml,
    numberBtnHtml,
  };
})();

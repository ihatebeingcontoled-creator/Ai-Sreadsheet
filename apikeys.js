/* apikeys.js — multi-service API key manager for the Outreach Ledger.
 *
 * Lets you keep several API keys per service (e.g. two Groq keys, so when
 * one runs out of credit you can switch), see at a glance which services
 * have a working key, and pick which key is "in production" (the one
 * actually used).
 *
 * Services today:
 *   info    -> powers Fetch Info / Generate Info (Groq, real, used by ai.js)
 *   email   -> reserved for a future real email-sending integration
 *   calling -> reserved for a future real cold-calling integration
 *
 * Email and Calls aren't wired to a real provider yet — this just gives you
 * a place to store and label those keys now, so the top bar and the switch
 * are already there once that gets built.
 *
 * Everything is stored only in this browser's localStorage.
 *
 * Other scripts talk to this through one global:
 *   window.APIKeys.getActiveKey(serviceId) -> string ("" if none)
 *   window.APIKeys.hasActiveKey(serviceId) -> bool
 *   window.APIKeys.openManager(serviceId)
 */

(function () {
  const STORE_KEY = "outreachLedger_apiKeys_v1";
  const OLD_GROQ_KEY = "outreachLedger_groqApiKey"; // ai.js's old single-key storage

  const SERVICES = [
    {
      id: "info",
      label: "Info Research",
      icon: "\uD83D\uDD0D",
      short: "Info",
      wired: true,
      desc: "Powers \u201CFetch Info\u201D / \u201CGenerate Info\u201D \u2014 real company research via Groq's web-search model. Free key at console.groq.com/keys.",
      placeholder: "gsk_...",
    },
    {
      id: "email",
      label: "Email Sending",
      icon: "\uD83D\uDCE7",
      short: "Email",
      wired: false,
      desc: "For automated email sending. Not connected to a real provider yet \u2014 sending is still simulated \u2014 but you can store and label keys here so they're ready.",
      placeholder: "API key...",
    },
    {
      id: "imessage",
      label: "iMessage",
      icon: "\uD83D\uDCAC",
      short: "iMsg",
      wired: false,
      desc: "For automated iMessage sending. Not connected to a real provider yet \u2014 sending is still simulated \u2014 but you can store and label keys here so they're ready.",
      placeholder: "API key...",
    },
    {
      id: "viber",
      label: "Viber",
      icon: "\uD83D\uDCF1",
      short: "Viber",
      wired: false,
      desc: "For automated Viber sending. Not connected to a real provider yet \u2014 sending is still simulated \u2014 but you can store and label keys here so they're ready.",
      placeholder: "API key...",
    },
    {
      id: "calling",
      label: "Cold Calling",
      icon: "\uD83D\uDCDE",
      short: "Calls",
      wired: false,
      desc: "For automated cold calling. Not connected to a real provider yet \u2014 calling is still simulated \u2014 but you can store and label keys here so they're ready.",
      placeholder: "API key...",
    },
  ];

  function serviceById(id) {
    return SERVICES.find((s) => s.id === id);
  }

  /* ---------- store ---------- */

  function defaultStore() {
    const s = {};
    SERVICES.forEach((sv) => (s[sv.id] = { activeId: null, keys: [] }));
    return s;
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return migrateOld();
      const parsed = JSON.parse(raw);
      const s = defaultStore();
      SERVICES.forEach((sv) => {
        if (parsed[sv.id]) s[sv.id] = parsed[sv.id];
      });
      return s;
    } catch (e) {
      return defaultStore();
    }
  }

  // one-time migration from ai.js's old single Groq key, if present
  function migrateOld() {
    const s = defaultStore();
    try {
      const oldKey = localStorage.getItem(OLD_GROQ_KEY);
      if (oldKey) {
        const id = "k" + Date.now();
        s.info.keys.push({ id, label: "Groq Key", value: oldKey });
        s.info.activeId = id;
        localStorage.removeItem(OLD_GROQ_KEY);
        saveStore(s);
      }
    } catch (e) {
      /* ignore */
    }
    return s;
  }

  function saveStore(s) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(s));
    } catch (e) {
      console.error("Could not save API keys:", e);
    }
  }

  let store = loadStore();

  function getActiveKey(serviceId) {
    const sv = store[serviceId];
    if (!sv || !sv.activeId) return "";
    const k = sv.keys.find((k) => k.id === sv.activeId);
    return k ? k.value : "";
  }
  function hasActiveKey(serviceId) {
    return !!getActiveKey(serviceId);
  }
  function listKeys(serviceId) {
    const sv = store[serviceId];
    return sv ? sv.keys.slice() : [];
  }
  function activeKeyId(serviceId) {
    const sv = store[serviceId];
    return sv ? sv.activeId : null;
  }

  function addKey(serviceId, label, value) {
    const sv = store[serviceId];
    if (!sv || !value) return;
    const id = "k" + Date.now() + Math.floor(Math.random() * 1000);
    sv.keys.push({ id, label: label || "Key " + (sv.keys.length + 1), value: value.trim() });
    if (!sv.activeId) sv.activeId = id; // first key for a service becomes active automatically
    saveStore(store);
    renderBar();
  }
  function updateKey(serviceId, keyId, fields) {
    const sv = store[serviceId];
    if (!sv) return;
    const k = sv.keys.find((k) => k.id === keyId);
    if (!k) return;
    if (typeof fields.label === "string") k.label = fields.label;
    if (typeof fields.value === "string" && fields.value.trim()) k.value = fields.value.trim();
    saveStore(store);
    renderBar();
  }
  function deleteKey(serviceId, keyId) {
    const sv = store[serviceId];
    if (!sv) return;
    sv.keys = sv.keys.filter((k) => k.id !== keyId);
    if (sv.activeId === keyId) sv.activeId = sv.keys.length ? sv.keys[0].id : null;
    saveStore(store);
    renderBar();
  }
  function setActive(serviceId, keyId) {
    const sv = store[serviceId];
    if (!sv) return;
    sv.activeId = keyId;
    saveStore(store);
    renderBar();
  }

  /* ---------- top status bar ---------- */

  function ensureBar() {
    if (document.getElementById("apiKeysBar")) return;
    const bar = document.createElement("div");
    bar.id = "apiKeysBar";
    // prefer a real spot in the page (e.g. the header slot in index.html) so it's part of
    // normal page flow and actually shows up — a position:fixed bar can get dropped by
    // full-page screenshot tools and can end up hidden behind other fixed elements
    const slot = document.getElementById("apiKeysBarSlot");
    if (slot) {
      bar.style.cssText = `
        display:flex; gap:9px; flex-wrap:wrap; justify-content:flex-end; align-items:flex-start;
        max-width:100%;
      `;
      slot.appendChild(bar);
    } else {
      bar.style.cssText = `
        position:fixed; top:14px; right:14px; z-index:999;
        display:flex; gap:9px; flex-wrap:wrap; justify-content:flex-end; max-width:360px;
      `;
      document.body.appendChild(bar);
    }
    renderBar();
  }

  function renderBar() {
    const bar = document.getElementById("apiKeysBar");
    if (!bar) return;
    bar.innerHTML = "";
    SERVICES.forEach((sv) => {
      const ok = hasActiveKey(sv.id);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = `${sv.icon} ${sv.short} ${ok ? "\u2705" : "\u274C"}`;
      btn.style.cssText = `
        font-family:'IBM Plex Mono', monospace; font-size:13.5px; font-weight:600;
        background:${ok ? "rgba(95,174,123,.14)" : "rgba(217,100,91,.14)"};
        color:${ok ? "#5fae7b" : "#d9645b"};
        border:1px solid ${ok ? "rgba(95,174,123,.35)" : "rgba(217,100,91,.35)"};
        padding:9px 16px; border-radius:24px; cursor:pointer; white-space:nowrap;
      `;
      btn.onclick = () => openManager(sv.id);
      bar.appendChild(btn);
    });
  }

  /* ---------- management modal ---------- */

  let editingKeyId = null; // key currently being edited inline, within the open modal

  function ensureModal() {
    if (document.getElementById("apiKeysOverlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "apiKeysOverlay";
    overlay.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:1000;
      display:none; align-items:center; justify-content:center; padding:20px;
    `;
    overlay.innerHTML = `
      <div style="background:#1c2024; border:1px solid #3a4148; border-radius:12px; padding:24px; width:100%; max-width:480px; max-height:82vh; overflow-y:auto; font-family:'IBM Plex Mono', monospace; color:#e9e6e0;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
          <div id="apiKeysModalTitle" style="font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:18px;"></div>
          <button id="apiKeysCloseX" style="background:none; border:none; color:#98a0a7; font-size:20px; cursor:pointer;">\u2715</button>
        </div>
        <div id="apiKeysModalDesc" style="font-size:13px; color:#98a0a7; margin-bottom:18px; line-height:1.55;"></div>
        <div id="apiKeysList"></div>
        <div style="margin-top:18px; padding-top:18px; border-top:1px solid #2b3137;">
          <div style="font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:#5f6870; margin-bottom:8px;">Add a key</div>
          <input id="apiKeysNewLabel" type="text" placeholder="Label (e.g. Personal key)" autocomplete="off" style="
            width:100%; background:#14171a; border:1px solid #3a4148; color:#e9e6e0;
            font-family:'IBM Plex Mono', monospace; font-size:14.5px; padding:11px 13px; border-radius:8px; box-sizing:border-box; margin-bottom:10px;
          "/>
          <input id="apiKeysNewValue" type="password" placeholder="API key..." autocomplete="off" style="
            width:100%; background:#14171a; border:1px solid #3a4148; color:#e9e6e0;
            font-family:'IBM Plex Mono', monospace; font-size:14.5px; padding:11px 13px; border-radius:8px; box-sizing:border-box;
          "/>
          <div style="display:flex; justify-content:flex-end; margin-top:12px;">
            <button id="apiKeysAddBtn" style="background:rgba(95,174,123,.14); border:1px solid rgba(95,174,123,.3); color:#5fae7b; font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:14.5px; padding:10px 20px; border-radius:8px; cursor:pointer;">+ Add Key</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeManager();
    });
    overlay.querySelector("#apiKeysCloseX").onclick = closeManager;
    overlay.querySelector("#apiKeysAddBtn").onclick = () => {
      if (!currentServiceId) return;
      const labelEl = overlay.querySelector("#apiKeysNewLabel");
      const valueEl = overlay.querySelector("#apiKeysNewValue");
      const value = valueEl.value.trim();
      if (!value) {
        valueEl.focus();
        return;
      }
      addKey(currentServiceId, labelEl.value.trim(), value);
      labelEl.value = "";
      valueEl.value = "";
      renderList();
    };

    // event delegation for the per-key row buttons, since rows are re-rendered often
    overlay.querySelector("#apiKeysList").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn || !currentServiceId) return;
      const action = btn.getAttribute("data-action");
      const keyId = btn.getAttribute("data-key-id");
      if (action === "use") {
        setActive(currentServiceId, keyId);
        renderList();
      } else if (action === "edit") {
        editingKeyId = keyId;
        renderList();
      } else if (action === "cancel-edit") {
        editingKeyId = null;
        renderList();
      } else if (action === "save-edit") {
        const row = btn.closest("[data-row-id]");
        const label = row.querySelector(".apk-edit-label").value.trim();
        const value = row.querySelector(".apk-edit-value").value;
        updateKey(currentServiceId, keyId, { label, value });
        editingKeyId = null;
        renderList();
      } else if (action === "delete") {
        const sv = store[currentServiceId];
        const k = sv.keys.find((k) => k.id === keyId);
        const ok = confirm(`Delete the key "${k ? k.label : ""}"? This can't be undone.`);
        if (ok) {
          deleteKey(currentServiceId, keyId);
          renderList();
        }
      }
    });
  }

  let currentServiceId = null;

  function maskValue(v) {
    if (!v) return "";
    if (v.length <= 6) return "\u2022".repeat(v.length);
    return v.slice(0, 4) + "\u2022\u2022\u2022\u2022" + v.slice(-4);
  }

  function renderList() {
    const sv = serviceById(currentServiceId);
    const listEl = document.getElementById("apiKeysList");
    if (!sv || !listEl) return;
    const keys = listKeys(currentServiceId);
    const activeId = activeKeyId(currentServiceId);

    if (keys.length === 0) {
      listEl.innerHTML = `<div style="font-size:12px; color:#5f6870; padding:10px 0;">No keys added yet.</div>`;
      return;
    }

    listEl.innerHTML = keys
      .map((k) => {
        const isActive = k.id === activeId;
        if (editingKeyId === k.id) {
          return `
            <div data-row-id="${k.id}" style="border:1px solid #3a4148; border-radius:10px; padding:14px; margin-bottom:10px; background:#20242a;">
              <input class="apk-edit-label" type="text" value="${escapeAttr(k.label)}" style="width:100%; background:#14171a; border:1px solid #3a4148; color:#e9e6e0; font-family:'IBM Plex Mono', monospace; font-size:14px; padding:9px 11px; border-radius:7px; box-sizing:border-box; margin-bottom:8px;" />
              <input class="apk-edit-value" type="password" placeholder="Leave blank to keep current key" style="width:100%; background:#14171a; border:1px solid #3a4148; color:#e9e6e0; font-family:'IBM Plex Mono', monospace; font-size:14px; padding:9px 11px; border-radius:7px; box-sizing:border-box;" />
              <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:10px;">
                <button data-action="cancel-edit" data-key-id="${k.id}" style="background:transparent; border:1px solid #3a4148; color:#e9e6e0; font-size:13.5px; padding:9px 14px; border-radius:7px; cursor:pointer;">Cancel</button>
                <button data-action="save-edit" data-key-id="${k.id}" style="background:rgba(90,143,214,.14); border:1px solid rgba(90,143,214,.3); color:#5a8fd6; font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:13.5px; padding:9px 14px; border-radius:7px; cursor:pointer;">Save</button>
              </div>
            </div>`;
        }
        return `
          <div style="border:1px solid ${isActive ? "rgba(95,174,123,.35)" : "#3a4148"}; border-radius:10px; padding:14px 16px; margin-bottom:10px; background:${isActive ? "rgba(95,174,123,.06)" : "#20242a"};">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
              <div style="min-width:0;">
                <div style="font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:15px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(k.label)}</div>
                <div style="font-size:12.5px; color:#5f6870; margin-top:3px;">${escapeHtml(maskValue(k.value))}</div>
              </div>
              ${isActive ? `<span style="flex-shrink:0; font-size:10.5px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:#5fae7b; background:rgba(95,174,123,.14); border:1px solid rgba(95,174,123,.3); padding:4px 10px; border-radius:20px; white-space:nowrap;">\u2713 In production</span>` : ""}
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:10px;">
              ${isActive ? "" : `<button data-action="use" data-key-id="${k.id}" style="background:rgba(90,143,214,.14); border:1px solid rgba(90,143,214,.3); color:#5a8fd6; font-family:'IBM Plex Mono', monospace; font-size:13px; padding:8px 14px; border-radius:7px; cursor:pointer;">Use this one</button>`}
              <button data-action="edit" data-key-id="${k.id}" style="background:transparent; border:1px solid #3a4148; color:#98a0a7; font-family:'IBM Plex Mono', monospace; font-size:13px; padding:8px 14px; border-radius:7px; cursor:pointer;">Edit</button>
              <button data-action="delete" data-key-id="${k.id}" style="background:transparent; border:1px solid rgba(217,100,91,.3); color:#d9645b; font-family:'IBM Plex Mono', monospace; font-size:13px; padding:8px 14px; border-radius:7px; cursor:pointer; margin-left:auto;">Delete</button>
            </div>
          </div>`;
      })
      .join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  function openManager(serviceId) {
    ensureModal();
    const sv = serviceById(serviceId) || SERVICES[0];
    currentServiceId = sv.id;
    editingKeyId = null;
    document.getElementById("apiKeysModalTitle").textContent = `${sv.icon} ${sv.label}`;
    document.getElementById("apiKeysModalDesc").textContent = sv.desc;
    document.getElementById("apiKeysNewValue").placeholder = sv.placeholder;
    document.getElementById("apiKeysNewLabel").value = "";
    document.getElementById("apiKeysNewValue").value = "";
    renderList();
    document.getElementById("apiKeysOverlay").style.display = "flex";
  }
  function closeManager() {
    const overlay = document.getElementById("apiKeysOverlay");
    if (overlay) overlay.style.display = "none";
    editingKeyId = null;
  }

  if (document.readyState !== "loading") ensureBar();
  else document.addEventListener("DOMContentLoaded", ensureBar);

  window.APIKeys = {
    getServices: () => SERVICES.slice(),
    getActiveKey,
    hasActiveKey,
    listKeys,
    addKey,
    updateKey,
    deleteKey,
    setActive,
    openManager,
  };
})();

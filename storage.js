/* storage.js — REAL cloud autosave/restore for the Outreach Ledger.
 *
 * Everything (companies, channels, templates, id counters) is saved to a
 * Cloudflare D1 database through a Cloudflare Pages Function that lives
 * right in this same repo, at functions/api/state.js. Because it's a
 * Pages Function (not a separately-deployed Worker), it's served from
 * the SAME domain as this site — so there's no API_BASE URL, no secret,
 * no wrangler, and no terminal. Deploying this site (via GitHub -> Pages)
 * deploys the API too.
 *
 * localStorage is kept ONLY as an instant-paint cache so the page isn't
 * blank for a split second on load — it is never the source of truth.
 * Every save round-trips to D1. If that write fails, you will SEE it (a
 * red "Save failed" pill, bottom-left) instead of a silent/fake success.
 *
 * index.html talks to this through:
 *   window.AppStorage.load()   -> Promise<{state,nextId,nextTemplateId}|null>
 *   window.AppStorage.save(x)  -> debounced write to D1 (fire-and-forget,
 *                                  but status is reported via the pill)
 *   window.AppStorage.clear()  -> deletes the saved row in D1
 */

(function () {
  // Same-origin: the API lives at /api/state on this exact site, served
  // by functions/api/state.js. No separate host to configure.
  const API_BASE = "";

  const CACHE_KEY = "outreachLedger_v1_cache"; // local instant-paint cache only
  const RECORD_ID = "default"; // single-user app: one row holds everything
  const DEBOUNCE_MS = 900;
  const RETRY_MS = 5000;

  let saveTimer = null;
  let retryTimer = null;
  let pendingData = null;

  /* ---------- tiny status pill so failures are never silent ---------- */

  function ensurePill() {
    let wrap = document.getElementById("d1SyncPill");
    if (wrap) return wrap;
    wrap = document.createElement("div");
    wrap.id = "d1SyncPill";
    wrap.style.cssText =
      "position:fixed; left:14px; bottom:14px; z-index:9999; display:flex; align-items:center; gap:8px; " +
      "font-family:'IBM Plex Mono',monospace; font-size:11.5px; padding:6px 8px 6px 12px; border-radius:20px; " +
      "border:1px solid #3a4148; background:#1c2024; color:#98a0a7; box-shadow:0 2px 10px rgba(0,0,0,.3); " +
      "transition:opacity .2s;";

    const label = document.createElement("span");
    label.id = "d1SyncPillLabel";
    wrap.appendChild(label);

    const btn = document.createElement("button");
    btn.id = "d1ForceSaveBtn";
    btn.type = "button";
    btn.textContent = "Force Save";
    btn.style.cssText =
      "font-family:inherit; font-size:10.5px; line-height:1; padding:5px 9px; border-radius:14px; " +
      "border:1px solid #3a4148; background:#262b30; color:#c7ccd1; cursor:pointer;";
    btn.addEventListener("mouseenter", () => (btn.style.background = "#2d333a"));
    btn.addEventListener("mouseleave", () => (btn.style.background = "#262b30"));
    btn.addEventListener("click", () => {
      if (window.AppStorage) window.AppStorage.forceSave();
    });
    wrap.appendChild(btn);

    document.body.appendChild(wrap);
    return wrap;
  }

  function setStatus(kind, detail) {
    ensurePill();
    const el = document.getElementById("d1SyncPillLabel");
    const wrap = document.getElementById("d1SyncPill");
    if (kind === "saving") {
      el.textContent = "\u2601\uFE0F Saving to D1\u2026";
      wrap.style.borderColor = "#3a4148";
      el.style.color = "#98a0a7";
    } else if (kind === "saved") {
      el.textContent = "\u2601\uFE0F Saved to D1";
      wrap.style.borderColor = "rgba(95,174,123,.35)";
      el.style.color = "#5fae7b";
    } else if (kind === "loading") {
      el.textContent = "\u2601\uFE0F Loading from D1\u2026";
      wrap.style.borderColor = "#3a4148";
      el.style.color = "#98a0a7";
    } else if (kind === "error") {
      el.textContent = "\u26A0\uFE0F Save FAILED \u2014 not stored in D1" + (detail ? " (" + detail + ")" : "");
      wrap.style.borderColor = "rgba(217,100,91,.4)";
      el.style.color = "#d9645b";
    }
  }

  /* ---------- local cache (instant paint / offline fallback only) ---------- */

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function writeCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch (e) {
      /* ignore quota errors — cache is best-effort only */
    }
  }

  /* ---------- real D1 load/save via the Pages Function ---------- */

  async function load() {
    setStatus("loading");
    try {
      const res = await fetch(`${API_BASE}/api/state?id=${encodeURIComponent(RECORD_ID)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json && json.data) {
        writeCache(json.data);
        setStatus("saved");
        return json.data;
      }
      // no row yet in D1 (first-ever run) — nothing to restore
      setStatus("saved");
      return null;
    } catch (e) {
      console.error("Could not load from D1:", e);
      setStatus("error", e.message);
      // fall back to the local cache purely so you don't lose the tab's
      // last-known state while the API is unreachable — this is clearly
      // flagged via the pill, not presented as a successful cloud load.
      return readCache();
    }
  }

  function save(data) {
    pendingData = data;
    writeCache(data); // instant local cache
    setStatus("saving");
    clearTimeout(saveTimer);
    clearTimeout(retryTimer);
    saveTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  async function flush() {
    if (pendingData === null) return;
    const toSend = pendingData;
    try {
      const res = await fetch(`${API_BASE}/api/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: RECORD_ID, data: toSend }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${text ? " " + text : ""}`);
      }
      setStatus("saved");
    } catch (e) {
      console.error("Autosave to D1 failed — this data is NOT saved server-side yet:", e);
      setStatus("error", e.message);
      // keep retrying rather than quietly dropping the write
      retryTimer = setTimeout(flush, RETRY_MS);
    }
  }

  // Manual "Force Save" button handler: skips the debounce and pushes
  // whatever the last-known state is to D1 right now. `pendingData` is set
  // by every save() call and is never cleared afterwards, so it always
  // holds the freshest state this tab has seen, even if nothing changed
  // since the last autosave.
  async function forceSave() {
    clearTimeout(saveTimer);
    clearTimeout(retryTimer);
    if (pendingData === null) {
      // nothing has been staged in this tab yet (e.g. right after load
      // with zero edits) — nothing new to push.
      setStatus("saved");
      return;
    }
    setStatus("saving");
    await flush();
  }

  async function clear() {
    localStorage.removeItem(CACHE_KEY);
    try {
      const res = await fetch(`${API_BASE}/api/state?id=${encodeURIComponent(RECORD_ID)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      console.error("Could not clear the D1 record:", e);
      setStatus("error", e.message);
    }
  }

  window.AppStorage = { load, save, clear, forceSave };
})();

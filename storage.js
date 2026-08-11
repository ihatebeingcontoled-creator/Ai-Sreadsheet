/* storage.js — autosave/restore for the Outreach Ledger.
 *
 * Everything (companies, channels, templates, id counters) gets written to
 * this browser's localStorage every time the app re-renders, and restored
 * on load. No server involved — this is purely per-browser persistence.
 *
 * index.html talks to this through one global:
 *   window.AppStorage.save(data)
 *   window.AppStorage.load() -> data | null
 */

(function () {
  const KEY = "outreachLedger_v1";

  function save(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      console.error("Autosave failed:", e);
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      console.error("Could not read saved data, starting fresh:", e);
      return null;
    }
  }

  function clear() {
    localStorage.removeItem(KEY);
  }

  window.AppStorage = { save, load, clear };
})();

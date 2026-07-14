// MapleScouter Cloud Presets — content script (isolated world).
//
// MapleScouter persists its /input state as Zustand `persist` stores in
// localStorage:
//   "preset"          -> {"state":{"preset":{"<slot>":{"data":…,"label":"…"}}},"version":N}
//   "character-store" -> live input state
//   "charBookmarkList", "region" -> bookmarks / region settings
// The isolated world shares the page origin's storage, so plain localStorage
// access here reads and writes the site's real data. The site itself applies
// imported state by reloading the page, and we do the same.
(() => {
  if (globalThis.__msCloudPresetsLoaded) return;
  globalThis.__msCloudPresetsLoaded = true;

  const SYNCED_KEYS = ["preset", "character-store", "charBookmarkList", "region"];

  function parsePresetEnvelope(raw) {
    if (!raw) return { exists: false, version: null, slots: [] };
    try {
      const envelope = JSON.parse(raw);
      const slotsObj = envelope?.state?.preset ?? {};
      const slots = Object.entries(slotsObj).map(([slot, entry]) => ({
        slot,
        label: entry?.label ?? `Slot ${slot}`,
        level: entry?.data?.stat?.level ?? null,
        class: entry?.data?.stat?.myClass ?? null,
        sizeBytes: JSON.stringify(entry).length,
      }));
      slots.sort((a, b) => Number(a.slot) - Number(b.slot));
      return { exists: true, version: envelope?.version ?? null, slots };
    } catch (e) {
      return { exists: true, version: null, slots: [], parseError: String(e) };
    }
  }

  function snapshot() {
    const raw = {};
    for (const key of SYNCED_KEYS) raw[key] = localStorage.getItem(key);
    return { ok: true, url: location.href, raw, presetMeta: parsePresetEnvelope(raw.preset) };
  }

  function getSlotEntry(slot) {
    try {
      const envelope = JSON.parse(localStorage.getItem("preset") ?? "null");
      const entry = envelope?.state?.preset?.[slot];
      if (!entry) return { ok: false, error: `No preset in slot ${slot}` };
      return { ok: true, entry, envelopeVersion: envelope?.version ?? null };
    } catch (e) {
      return { ok: false, error: `Could not parse the site's preset storage: ${e}` };
    }
  }

  function importSlot(slot, entry, envelopeVersion) {
    let envelope;
    try {
      envelope = JSON.parse(localStorage.getItem("preset") ?? "null");
    } catch {
      envelope = null;
    }
    if (!envelope || typeof envelope !== "object" || !envelope.state) {
      envelope = { state: { preset: {} }, version: envelopeVersion ?? 0 };
    }
    if (!envelope.state.preset || typeof envelope.state.preset !== "object") {
      envelope.state.preset = {};
    }
    envelope.state.preset[String(slot)] = entry;
    localStorage.setItem("preset", JSON.stringify(envelope));
    return { ok: true, localVersion: envelope.version ?? null };
  }

  function restore(payload) {
    const written = [];
    for (const key of SYNCED_KEYS) {
      if (!(key in payload)) continue;
      const value = payload[key];
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
      written.push(key);
    }
    return { ok: true, written };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      switch (message?.type) {
        case "MS_SNAPSHOT":
          sendResponse(snapshot());
          break;
        case "MS_GET_SLOT":
          sendResponse(getSlotEntry(message.slot));
          break;
        case "MS_IMPORT_SLOT":
          sendResponse(importSlot(message.slot, message.entry, message.envelopeVersion));
          break;
        case "MS_RESTORE":
          sendResponse(restore(message.payload));
          break;
        case "MS_RELOAD":
          sendResponse({ ok: true });
          location.reload();
          break;
        default:
          sendResponse({ ok: false, error: `Unknown message: ${message?.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return false;
  });
})();

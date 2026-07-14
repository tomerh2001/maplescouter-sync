const statusEl = document.getElementById("status");
let activeTab = null;
let localMeta = null;

function setStatus(text, isError = false) {
  statusEl.hidden = !text;
  statusEl.textContent = text ?? "";
  statusEl.classList.toggle("error", isError);
}

function swCall(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

async function contentCall(message) {
  if (!activeTab) return { ok: false, error: "No MapleScouter tab is active." };
  try {
    return await chrome.tabs.sendMessage(activeTab.id, message);
  } catch {
    // The tab may predate the extension install — inject the script and retry.
    try {
      await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ["content.js"] });
      return await chrome.tabs.sendMessage(activeTab.id, message);
    } catch (e) {
      return { ok: false, error: `Cannot talk to the page: ${e.message}. Try reloading the tab.` };
    }
  }
}

function deviceName() {
  const ua = navigator.userAgent;
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Mac")) return "macOS";
  if (ua.includes("Linux")) return "Linux";
  return "Unknown";
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function fmtKb(bytes) {
  return `${Math.max(1, Math.round((bytes ?? 0) / 1024))} KB`;
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString() : "";
}

async function renderLocal() {
  const container = document.getElementById("localSlots");
  const snap = await contentCall({ type: "MS_SNAPSHOT" });
  if (!snap?.ok) {
    setStatus(snap?.error ?? "Could not read the page storage.", true);
    return;
  }
  localMeta = snap.presetMeta;
  document.getElementById("localSection").hidden = false;
  container.replaceChildren();
  if (!localMeta.slots.length) {
    container.append(
      el("p", {
        class: "muted",
        text: "No saved presets in this browser yet — use the site's “Save Preset” first, or import one from the cloud below.",
      }),
    );
  }
  for (const slot of localMeta.slots) {
    container.append(
      el("div", { class: "row item" }, [
        el("span", { class: "grow", text: `#${slot.slot} ${slot.label}` }),
        el("span", { class: "muted", text: fmtKb(slot.sizeBytes) }),
        el("button", { text: "Upload", onclick: () => uploadSlot(slot) }),
      ]),
    );
  }
}

async function uploadSlot(slot) {
  setStatus(`Uploading slot ${slot.slot}…`);
  const got = await contentCall({ type: "MS_GET_SLOT", slot: slot.slot });
  if (!got?.ok) {
    setStatus(got?.error ?? "Reading the slot failed.", true);
    return;
  }
  const res = await swCall("API_CREATE_PRESET", {
    body: {
      label: got.entry?.label ?? slot.label,
      entry: got.entry,
      envelopeVersion: got.envelopeVersion,
      device: deviceName(),
    },
  });
  if (!res?.ok) {
    setStatus(res?.error ?? "Upload failed.", true);
    return;
  }
  setStatus(`Uploaded “${res.data.label}” ✔`);
  renderCloud();
}

async function importPreset(preset, slotSelect) {
  const slot = slotSelect.value;
  if (
    localMeta?.exists &&
    localMeta.version !== null &&
    preset.envelopeVersion !== null &&
    preset.envelopeVersion !== localMeta.version
  ) {
    const go = confirm(
      `This cloud preset was saved with site storage version ${preset.envelopeVersion}, but this browser has version ${localMeta.version}. The site may have changed its format since. Import anyway?`,
    );
    if (!go) return;
  }
  setStatus("Importing…");
  const full = await swCall("API_GET_PRESET", { id: preset.id });
  if (!full?.ok) {
    setStatus(full?.error ?? "Download failed.", true);
    return;
  }
  const wrote = await contentCall({
    type: "MS_IMPORT_SLOT",
    slot,
    entry: full.data.entry,
    envelopeVersion: full.data.envelopeVersion,
  });
  if (!wrote?.ok) {
    setStatus(wrote?.error ?? "Writing to the page failed.", true);
    return;
  }
  setStatus(`Imported into slot ${slot} — reloading the page…`);
  await contentCall({ type: "MS_RELOAD" });
  setTimeout(() => window.close(), 400);
}

async function renderCloud() {
  const container = document.getElementById("cloudList");
  const res = await swCall("API_LIST_PRESETS");
  container.replaceChildren();
  if (!res?.ok) {
    container.append(el("p", { class: "error", text: res?.error ?? "Failed to load cloud presets." }));
    return;
  }
  const presets = res.data.presets;
  if (!presets.length) {
    container.append(el("p", { class: "muted", text: "No cloud presets yet — upload one from a local slot." }));
    return;
  }
  for (const preset of presets) {
    const slotSelect = el(
      "select",
      { title: "Target slot" },
      ["1", "2", "3", "4", "5", "6", "7", "8"].map((n) => el("option", { value: n, text: `#${n}` })),
    );
    const metaBits = [
      preset.gameMeta?.level ? `Lv ${preset.gameMeta.level}` : null,
      preset.gameMeta?.class ?? null,
      preset.device,
      fmtDate(preset.updatedAt),
    ]
      .filter(Boolean)
      .join(" · ");
    container.append(
      el("div", { class: "item" }, [
        el("div", { class: "row" }, [
          el("span", { class: "grow", text: preset.label }),
          el("span", { class: "muted", text: fmtKb(preset.sizeBytes) }),
        ]),
        el("div", { class: "row" }, [
          el("span", { class: "muted grow", text: metaBits }),
          ...(activeTab
            ? [slotSelect, el("button", { text: "Import", onclick: () => importPreset(preset, slotSelect) })]
            : []),
          el("button", {
            class: "danger",
            text: "✕",
            title: "Delete from cloud",
            onclick: async () => {
              if (!confirm(`Delete “${preset.label}” from the cloud?`)) return;
              const del = await swCall("API_DELETE_PRESET", { id: preset.id });
              if (!del?.ok) {
                setStatus(del?.error ?? "Delete failed.", true);
                return;
              }
              renderCloud();
            },
          }),
        ]),
      ]),
    );
  }
}

async function backupNow() {
  setStatus("Backing up…");
  const snap = await contentCall({ type: "MS_SNAPSHOT" });
  if (!snap?.ok) {
    setStatus(snap?.error ?? "Could not read the page storage.", true);
    return;
  }
  const res = await swCall("API_CREATE_BACKUP", { body: { payload: snap.raw, device: deviceName() } });
  setStatus(
    res?.ok ? `Backed up full state (${fmtKb(res.data.sizeBytes)}) ✔` : (res?.error ?? "Backup failed."),
    !res?.ok,
  );
}

async function restoreLatest() {
  const res = await swCall("API_LATEST_BACKUP");
  if (!res?.ok) {
    setStatus(res?.error ?? "No backup found.", true);
    return;
  }
  const when = fmtDate(res.data.createdAt);
  const ok = confirm(
    `Restore the full MapleScouter state from ${when} (${res.data.device ?? "unknown device"})? This overwrites this browser's presets, current input, bookmarks and region.`,
  );
  if (!ok) return;
  const wrote = await contentCall({ type: "MS_RESTORE", payload: res.data.payload });
  if (!wrote?.ok) {
    setStatus(wrote?.error ?? "Restore failed.", true);
    return;
  }
  setStatus("Restored — reloading the page…");
  await contentCall({ type: "MS_RELOAD" });
  setTimeout(() => window.close(), 400);
}

async function init() {
  document.getElementById("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
  document
    .getElementById("openSite")
    .addEventListener("click", () => chrome.tabs.create({ url: "https://maplescouter.com/en/input" }));
  document.getElementById("backupNow").addEventListener("click", backupNow);
  document.getElementById("restoreLatest").addEventListener("click", restoreLatest);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onSite =
    tab?.url?.startsWith("https://maplescouter.com/") || tab?.url?.startsWith("https://www.maplescouter.com/");
  activeTab = onSite ? tab : null;
  document.getElementById("notOnSite").hidden = Boolean(onSite);
  if (onSite) await renderLocal();
  await renderCloud();
}

init();

const $ = (id) => document.getElementById(id);

function setStatus(text, isError = false) {
  const status = $("status");
  status.hidden = !text;
  status.textContent = text ?? "";
  status.classList.toggle("error", isError);
}

function normalizedOrigin() {
  try {
    const url = new URL($("serverUrl").value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function updateGrantState() {
  const origin = normalizedOrigin();
  if (!origin) {
    $("grantState").textContent = "";
    return;
  }
  const granted = await chrome.permissions.contains({ origins: [origin + "/*"] });
  $("grantState").textContent = granted
    ? `✔ host access granted for ${origin}`
    : `Host access for ${origin} not granted yet — click Save.`;
}

async function save(event) {
  event.preventDefault();
  const origin = normalizedOrigin();
  if (!origin) {
    setStatus("Enter a valid http(s) server URL first.", true);
    return;
  }
  const granted = await chrome.permissions.request({ origins: [origin + "/*"] });
  if (!granted) {
    setStatus("Host access was not granted — the extension cannot reach the server without it.", true);
    return;
  }
  await chrome.storage.local.set({
    serverUrl: $("serverUrl").value.trim().replace(/\/+$/, ""),
    username: $("username").value.trim(),
    appPassword: $("appPassword").value,
  });
  setStatus("Saved ✔");
  updateGrantState();
}

async function testConnection() {
  setStatus("Testing…");
  const res = await chrome.runtime.sendMessage({ type: "API_TEST" });
  if (res?.ok) {
    setStatus(`Connected ✔ — ${res.data.presets.length} preset(s) in the cloud.`);
  } else {
    setStatus(res?.error ?? "Connection failed.", true);
  }
}

async function load() {
  const cfg = await chrome.storage.local.get({ serverUrl: "", username: "", appPassword: "" });
  $("serverUrl").value = cfg.serverUrl;
  $("username").value = cfg.username;
  $("appPassword").value = cfg.appPassword;
  $("form").addEventListener("submit", save);
  $("test").addEventListener("click", testConnection);
  $("serverUrl").addEventListener("input", updateGrantState);
  updateGrantState();
}

load();

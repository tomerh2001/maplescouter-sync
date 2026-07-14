// MapleScouter Cloud Presets — MV3 service worker.
//
// Stateless by design: Chrome kills this worker after ~30s of inactivity, so
// configuration lives in chrome.storage.local and every request re-reads it.
// All API traffic goes through here (content scripts fetch under the page's
// origin and would be blocked by CORS; the worker fetches under the
// extension's granted host permissions, so the server needs no CORS setup).
//
// Auth: HTTP Basic with an Authentik *app password*. The Authentik proxy
// provider in front of the server validates the Authorization header
// (default "Intercept header authentication"), so no route bypass exists.

async function getConfig() {
  return chrome.storage.local.get({ serverUrl: "", username: "", appPassword: "" });
}

function basicAuth(username, appPassword) {
  return "Basic " + btoa(`${username}:${appPassword}`);
}

async function api(path, { method = "GET", body } = {}) {
  const { serverUrl, username, appPassword } = await getConfig();
  if (!serverUrl || !username || !appPassword) {
    return {
      ok: false,
      status: 0,
      error: "Not configured — open the extension options and set the server URL, username and app password.",
    };
  }
  const url = serverUrl.replace(/\/+$/, "") + path;
  let res;
  try {
    res = await fetch(url, {
      method,
      redirect: "manual",
      headers: {
        Authorization: basicAuth(username, appPassword),
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: `Network error: ${e.message}. If this is the first use, grant host access from the options page.`,
    };
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    return {
      ok: false,
      status: res.status || 302,
      error:
        "The auth proxy redirected the request instead of accepting the credentials. Check that the Authentik application for the sync server exists and header authentication is enabled.",
    };
  }
  if (res.status === 401) {
    return { ok: false, status: 401, error: "Rejected (401): the Authentik app password is wrong or expired." };
  }
  if (res.status === 403) {
    return { ok: false, status: 403, error: "Rejected (403): this user is not allowed on the sync server." };
  }
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      return {
        ok: false,
        status: res.status,
        error: `Unexpected non-JSON response (HTTP ${res.status}) — is the server URL right?`,
      };
    }
  }
  if (!res.ok) return { ok: false, status: res.status, error: data?.error ?? `HTTP ${res.status}` };
  return { ok: true, status: res.status, data };
}

const handlers = {
  API_TEST: () => api("/api/v1/presets"),
  API_LIST_PRESETS: () => api("/api/v1/presets"),
  API_GET_PRESET: (msg) => api(`/api/v1/presets/${encodeURIComponent(msg.id)}`),
  API_CREATE_PRESET: (msg) => api("/api/v1/presets", { method: "POST", body: msg.body }),
  API_UPDATE_PRESET: (msg) => api(`/api/v1/presets/${encodeURIComponent(msg.id)}`, { method: "PUT", body: msg.body }),
  API_DELETE_PRESET: (msg) => api(`/api/v1/presets/${encodeURIComponent(msg.id)}`, { method: "DELETE" }),
  API_LIST_BACKUPS: () => api("/api/v1/backups"),
  API_CREATE_BACKUP: (msg) => api("/api/v1/backups", { method: "POST", body: msg.body }),
  API_LATEST_BACKUP: () => api("/api/v1/backups/latest"),
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message).then(sendResponse, (e) => sendResponse({ ok: false, status: 0, error: String(e) }));
  return true; // keep the message channel open for the async response
});

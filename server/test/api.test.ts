import assert from "node:assert/strict";
import test from "node:test";
import { createApp, type AppOptions } from "../src/app.js";

const USER = { "X-authentik-username": "tomer" };
const JSON_HEADERS = { ...USER, "Content-Type": "application/json" };

function makeApp(overrides: Partial<AppOptions> = {}) {
  return createApp({ dbPath: ":memory:", backupKeep: 2, versionKeep: 2, ...overrides }).app;
}

const sampleEntry = (level: number) => ({
  label: `Lv ${level} Shade`,
  data: { stat: { level, myClass: "Shade", mainStatBase: 12345 } },
});

test("healthz is open", async () => {
  const app = makeApp();
  const res = await app.request("/healthz");
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { ok: boolean }).ok, true);
});

test("api requires the forward-auth username header", async () => {
  const app = makeApp();
  const res = await app.request("/api/v1/presets");
  assert.equal(res.status, 401);
});

test("allowlist rejects unknown users", async () => {
  const app = makeApp({ allowedUsers: ["someone-else"] });
  const res = await app.request("/api/v1/presets", { headers: USER });
  assert.equal(res.status, 403);
});

test("preset CRUD with version history", async () => {
  const app = makeApp();
  const created = await app.request("/api/v1/presets", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ entry: sampleEntry(280), envelopeVersion: 0, device: "test" }),
  });
  assert.equal(created.status, 201);
  const preset = (await created.json()) as { id: string; label: string; gameMeta: { level: number } };
  assert.equal(preset.label, "Lv 280 Shade");
  assert.equal(preset.gameMeta.level, 280);

  const list = await app.request("/api/v1/presets", { headers: USER });
  assert.equal(((await list.json()) as { presets: unknown[] }).presets.length, 1);

  for (const level of [285, 290, 295]) {
    const updated = await app.request(`/api/v1/presets/${preset.id}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ entry: sampleEntry(level) }),
    });
    assert.equal(updated.status, 200);
  }

  const latest = (await (await app.request(`/api/v1/presets/${preset.id}`, { headers: USER })).json()) as {
    gameMeta: { level: number };
  };
  assert.equal(latest.gameMeta.level, 295);

  const versions = await app.request(`/api/v1/presets/${preset.id}/versions`, { headers: USER });
  const versionList = (await versions.json()) as { versions: { id: number }[] };
  assert.equal(versionList.versions.length, 2); // pruned to versionKeep

  const versionFull = await app.request(
    `/api/v1/presets/${preset.id}/versions/${versionList.versions[0].id}`,
    { headers: USER },
  );
  assert.equal(versionFull.status, 200);

  const del = await app.request(`/api/v1/presets/${preset.id}`, { method: "DELETE", headers: USER });
  assert.equal(del.status, 200);
  const gone = await app.request(`/api/v1/presets/${preset.id}`, { headers: USER });
  assert.equal(gone.status, 404);
});

test("users cannot see each other's presets", async () => {
  const app = makeApp();
  await app.request("/api/v1/presets", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ entry: sampleEntry(280) }),
  });
  const other = await app.request("/api/v1/presets", { headers: { "X-authentik-username": "shade" } });
  assert.equal(((await other.json()) as { presets: unknown[] }).presets.length, 0);
});

test("backups: latest wins and old ones are pruned", async () => {
  const app = makeApp(); // backupKeep: 2
  for (const n of [1, 2, 3]) {
    const res = await app.request("/api/v1/backups", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ payload: { preset: `envelope-${n}` }, device: "test" }),
    });
    assert.equal(res.status, 201);
  }
  const list = (await (await app.request("/api/v1/backups", { headers: USER })).json()) as {
    backups: unknown[];
  };
  assert.equal(list.backups.length, 2);
  const latest = (await (await app.request("/api/v1/backups/latest", { headers: USER })).json()) as {
    payload: { preset: string };
  };
  assert.equal(latest.payload.preset, "envelope-3");
});

test("rejects malformed bodies", async () => {
  const app = makeApp();
  const notJson = await app.request("/api/v1/presets", {
    method: "POST",
    headers: JSON_HEADERS,
    body: "{not json",
  });
  assert.equal(notJson.status, 400);
  const noEntry = await app.request("/api/v1/presets", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ label: "x" }),
  });
  assert.equal(noEntry.status, 400);
});

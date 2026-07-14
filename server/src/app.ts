import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { logger } from "hono/logger";
import { openDb } from "./db.js";

export interface AppOptions {
  dbPath: string;
  /** Usernames allowed through. Empty/undefined = any authenticated username. */
  allowedUsers?: string[];
  maxBodyBytes?: number;
  /** Full-state backups kept per user before pruning. */
  backupKeep?: number;
  /** Historical revisions kept per preset before pruning. */
  versionKeep?: number;
  enableLogger?: boolean;
}

interface PresetRow {
  id: string;
  user: string;
  label: string;
  envelope_version: number | null;
  entry: string;
  game_meta: string | null;
  device: string | null;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: number;
  preset_id: string;
  user: string;
  label: string;
  envelope_version: number | null;
  entry: string;
  saved_at: string;
}

interface BackupRow {
  id: number;
  user: string;
  payload: string;
  device: string | null;
  created_at: string;
}

const now = () => new Date().toISOString();

function presetMeta(row: PresetRow) {
  return {
    id: row.id,
    label: row.label,
    envelopeVersion: row.envelope_version,
    gameMeta: row.game_meta ? JSON.parse(row.game_meta) : null,
    device: row.device,
    sizeBytes: Buffer.byteLength(row.entry, "utf8"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function presetFull(row: PresetRow) {
  return { ...presetMeta(row), entry: JSON.parse(row.entry) };
}

function backupMeta(row: BackupRow) {
  return {
    id: row.id,
    device: row.device,
    sizeBytes: Buffer.byteLength(row.payload, "utf8"),
    createdAt: row.created_at,
  };
}

function backupFull(row: BackupRow) {
  return { ...backupMeta(row), payload: JSON.parse(row.payload) };
}

/** Best-effort {level, class} extraction from a MapleScouter preset entry. */
function extractGameMeta(entry: unknown): string | null {
  try {
    const stat = (entry as { data?: { stat?: Record<string, unknown> } })?.data?.stat;
    if (!stat || typeof stat !== "object") return null;
    const meta: Record<string, unknown> = {};
    if (stat.level !== undefined) meta.level = stat.level;
    if (stat.myClass !== undefined) meta.class = stat.myClass;
    return Object.keys(meta).length ? JSON.stringify(meta) : null;
  } catch {
    return null;
  }
}

export function createApp(opts: AppOptions) {
  const db = openDb(opts.dbPath);
  const allowed = (opts.allowedUsers ?? []).map((u) => u.trim()).filter(Boolean);
  const maxBody = opts.maxBodyBytes ?? 8 * 1024 * 1024;
  const backupKeep = opts.backupKeep ?? 30;
  const versionKeep = opts.versionKeep ?? 20;

  const app = new Hono<{ Variables: { user: string } }>();
  if (opts.enableLogger) app.use(logger());

  app.get("/healthz", (c) => c.json({ ok: true, service: "maplescouter-sync" }));

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: maxBody,
      onError: (c) => c.json({ error: "payload too large" }, 413),
    }),
  );

  // Identity comes from the Authentik forward-auth proxy in front of this
  // container; the container is never exposed directly.
  app.use("/api/*", async (c, next) => {
    const user = c.req.header("x-authentik-username");
    if (!user) {
      return c.json(
        { error: "unauthenticated: missing X-authentik-username header (requests must arrive through the Authentik-protected reverse proxy)" },
        401,
      );
    }
    if (allowed.length > 0 && !allowed.includes(user)) {
      return c.json({ error: `user '${user}' is not allowed` }, 403);
    }
    c.set("user", user);
    await next();
  });

  const getOwned = (user: string, id: string) =>
    db.prepare("SELECT * FROM presets WHERE id = ? AND user = ?").get(id, user) as PresetRow | undefined;

  // ---- presets ----

  app.get("/api/v1/presets", (c) => {
    const rows = db
      .prepare("SELECT * FROM presets WHERE user = ? ORDER BY updated_at DESC")
      .all(c.get("user")) as PresetRow[];
    return c.json({ presets: rows.map(presetMeta) });
  });

  app.post("/api/v1/presets", async (c) => {
    let body: { label?: unknown; entry?: unknown; envelopeVersion?: unknown; device?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (body.entry === null || typeof body.entry !== "object") {
      return c.json({ error: "'entry' (object) is required" }, 400);
    }
    const entryLabel = (body.entry as { label?: unknown }).label;
    const label =
      typeof body.label === "string" && body.label.trim()
        ? body.label.trim()
        : typeof entryLabel === "string" && entryLabel
          ? entryLabel
          : "Preset";
    const ts = now();
    const row: PresetRow = {
      id: randomUUID(),
      user: c.get("user"),
      label,
      envelope_version: typeof body.envelopeVersion === "number" ? body.envelopeVersion : null,
      entry: JSON.stringify(body.entry),
      game_meta: extractGameMeta(body.entry),
      device: typeof body.device === "string" ? body.device : null,
      created_at: ts,
      updated_at: ts,
    };
    db.prepare(
      `INSERT INTO presets (id, user, label, envelope_version, entry, game_meta, device, created_at, updated_at)
       VALUES (@id, @user, @label, @envelope_version, @entry, @game_meta, @device, @created_at, @updated_at)`,
    ).run(row);
    return c.json(presetFull(row), 201);
  });

  app.get("/api/v1/presets/:id", (c) => {
    const row = getOwned(c.get("user"), c.req.param("id"));
    return row ? c.json(presetFull(row)) : c.json({ error: "not found" }, 404);
  });

  app.put("/api/v1/presets/:id", async (c) => {
    const row = getOwned(c.get("user"), c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    let body: { label?: unknown; entry?: unknown; envelopeVersion?: unknown; device?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (body.entry === null || typeof body.entry !== "object") {
      return c.json({ error: "'entry' (object) is required" }, 400);
    }
    // Last write wins, but the previous revision is kept (and pruned to versionKeep).
    db.prepare(
      "INSERT INTO preset_versions (preset_id, user, label, envelope_version, entry, saved_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(row.id, row.user, row.label, row.envelope_version, row.entry, row.updated_at);
    db.prepare(
      `DELETE FROM preset_versions WHERE preset_id = ?
       AND id NOT IN (SELECT id FROM preset_versions WHERE preset_id = ? ORDER BY id DESC LIMIT ?)`,
    ).run(row.id, row.id, versionKeep);

    const updated: PresetRow = {
      ...row,
      label: typeof body.label === "string" && body.label.trim() ? body.label.trim() : row.label,
      envelope_version: typeof body.envelopeVersion === "number" ? body.envelopeVersion : row.envelope_version,
      entry: JSON.stringify(body.entry),
      game_meta: extractGameMeta(body.entry) ?? row.game_meta,
      device: typeof body.device === "string" ? body.device : row.device,
      updated_at: now(),
    };
    db.prepare(
      `UPDATE presets SET label = @label, envelope_version = @envelope_version, entry = @entry,
       game_meta = @game_meta, device = @device, updated_at = @updated_at WHERE id = @id AND user = @user`,
    ).run({
      id: updated.id,
      user: updated.user,
      label: updated.label,
      envelope_version: updated.envelope_version,
      entry: updated.entry,
      game_meta: updated.game_meta,
      device: updated.device,
      updated_at: updated.updated_at,
    });
    return c.json(presetFull(updated));
  });

  app.delete("/api/v1/presets/:id", (c) => {
    const row = getOwned(c.get("user"), c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    db.prepare("DELETE FROM preset_versions WHERE preset_id = ?").run(row.id);
    db.prepare("DELETE FROM presets WHERE id = ?").run(row.id);
    return c.json({ ok: true });
  });

  app.get("/api/v1/presets/:id/versions", (c) => {
    const row = getOwned(c.get("user"), c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const versions = db
      .prepare("SELECT * FROM preset_versions WHERE preset_id = ? ORDER BY id DESC")
      .all(row.id) as VersionRow[];
    return c.json({
      versions: versions.map((v) => ({
        id: v.id,
        label: v.label,
        envelopeVersion: v.envelope_version,
        sizeBytes: Buffer.byteLength(v.entry, "utf8"),
        savedAt: v.saved_at,
      })),
    });
  });

  app.get("/api/v1/presets/:id/versions/:versionId", (c) => {
    const row = getOwned(c.get("user"), c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const version = db
      .prepare("SELECT * FROM preset_versions WHERE preset_id = ? AND id = ?")
      .get(row.id, Number(c.req.param("versionId"))) as VersionRow | undefined;
    if (!version) return c.json({ error: "version not found" }, 404);
    return c.json({
      id: version.id,
      label: version.label,
      envelopeVersion: version.envelope_version,
      entry: JSON.parse(version.entry),
      savedAt: version.saved_at,
    });
  });

  // ---- full-state backups ----

  app.post("/api/v1/backups", async (c) => {
    let body: { payload?: unknown; device?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (body.payload === null || typeof body.payload !== "object") {
      return c.json({ error: "'payload' (object of localStorage key -> raw string) is required" }, 400);
    }
    const user = c.get("user");
    const info = db
      .prepare("INSERT INTO backups (user, payload, device, created_at) VALUES (?, ?, ?, ?)")
      .run(user, JSON.stringify(body.payload), typeof body.device === "string" ? body.device : null, now());
    db.prepare(
      "DELETE FROM backups WHERE user = ? AND id NOT IN (SELECT id FROM backups WHERE user = ? ORDER BY id DESC LIMIT ?)",
    ).run(user, user, backupKeep);
    const row = db.prepare("SELECT * FROM backups WHERE id = ?").get(info.lastInsertRowid) as BackupRow;
    return c.json(backupMeta(row), 201);
  });

  app.get("/api/v1/backups", (c) => {
    const rows = db
      .prepare("SELECT * FROM backups WHERE user = ? ORDER BY id DESC")
      .all(c.get("user")) as BackupRow[];
    return c.json({ backups: rows.map(backupMeta) });
  });

  app.get("/api/v1/backups/latest", (c) => {
    const row = db
      .prepare("SELECT * FROM backups WHERE user = ? ORDER BY id DESC LIMIT 1")
      .get(c.get("user")) as BackupRow | undefined;
    return row ? c.json(backupFull(row)) : c.json({ error: "no backups yet" }, 404);
  });

  app.get("/api/v1/backups/:id", (c) => {
    const row = db
      .prepare("SELECT * FROM backups WHERE id = ? AND user = ?")
      .get(Number(c.req.param("id")), c.get("user")) as BackupRow | undefined;
    return row ? c.json(backupFull(row)) : c.json({ error: "not found" }, 404);
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));

  return { app, db };
}

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const { app, db } = createApp({
  dbPath: process.env.DB_PATH ?? "/app/data/sync.db",
  allowedUsers: (process.env.ALLOWED_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES ?? 8 * 1024 * 1024),
  backupKeep: Number(process.env.BACKUP_KEEP ?? 30),
  versionKeep: Number(process.env.VERSION_KEEP ?? 20),
  enableLogger: process.env.LOG_REQUESTS !== "false",
});

const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`maplescouter-sync listening on :${info.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Fall back if open connections keep the server from closing.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

// Sanity checks for the unpacked extension: manifest parses, is MV3, and every
// file it references exists. Keeps the zip artifact loadable.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = "extension";
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

if (manifest.manifest_version !== 3) throw new Error("manifest_version must be 3");

const files = new Set();
files.add(manifest.background.service_worker);
for (const contentScript of manifest.content_scripts ?? []) {
  for (const file of contentScript.js ?? []) files.add(file);
}
files.add(manifest.action.default_popup);
files.add(manifest.options_ui.page);
for (const icon of Object.values(manifest.icons ?? {})) files.add(icon);
for (const icon of Object.values(manifest.action.default_icon ?? {})) files.add(icon);

const missing = [...files].filter((file) => !existsSync(join(root, file)));
if (missing.length) throw new Error(`manifest references missing files: ${missing.join(", ")}`);

console.log(`manifest OK — ${files.size} referenced files present`);

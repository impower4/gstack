/**
 * A fake `gbrain` CLI backed by a JSON file, for memory-ingest landing tests
 * (A1/A4). It speaks the gbrain HEAD (0.60) shapes gstack relies on:
 * `import <dir> --json [--source-id]`, `list --source-id --limit`,
 * `get <slug> --source-id --json`, `sources list --json`, `sources add`.
 *
 * Behavior switches (env, read by the fake at run time):
 *   FAKE_FAIL=<substr>     pages whose path contains it fail by name (HEAD `failures`)
 *   FAKE_PENDING=<substr>  accepted as a managed-import Pending receipt: counted, never stored
 *   FAKE_POISON=<substr>   any batch containing it fails without naming a page
 *   FAKE_OLD_JSON=1        pre-0.48: no failures/unchanged/source_id keys, and a
 *                          returned failure counts only as skipped (exit 0)
 *   FAKE_LIST_UNSCOPED=1   `list` ignores --source-id (pre-0.46.25)
 *   FAKE_BUSY=1            list/get answer {"error":"pglite_busy"} with exit 1
 *   FAKE_NO_SOURCES=1      `sources add` is unsupported
 *   FAKE_MANAGED=1         gbrain 0.60 managed persistence: `sources writer status`
 *                          reports bindings; `sources add --path` binds (and binds a
 *                          path-less source of the same id); an import into a source
 *                          with no active binding owned by FAKE_HOST_ID (default
 *                          host-local) is refused per file, and a bound import writes
 *                          each page through to the checkout
 *   FAKE_COPY_STAGE=<dir>  import copies the staged directory to <dir> first
 * Every call is appended to $HOME/gbrain-calls.log.
 */
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export function installFakeBrain(home: string): { binDir: string; brainFile: string; callLog: string } {
  const binDir = join(home, "fake-brain-bin");
  mkdirSync(binDir, { recursive: true });
  const brainFile = join(home, "fake-brain.json");
  const callLog = join(home, "gbrain-calls.log");
  writeFileSync(join(binDir, "gbrain"), `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const env = process.env;
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + "\\n");
const brainFile = ${JSON.stringify(brainFile)};
const brain = fs.existsSync(brainFile) ? JSON.parse(fs.readFileSync(brainFile, "utf8")) : { sources: { default: { federated: true } }, pages: {} };
const save = () => fs.writeFileSync(brainFile, JSON.stringify(brain, null, 2));
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const busy = () => { if (env.FAKE_BUSY === "1") { console.log(JSON.stringify({ error: "pglite_busy" })); process.exit(1); } };
const cmd = args[0];
const managed = env.FAKE_MANAGED === "1";
const hostId = env.FAKE_HOST_ID || "host-local";
const ownBinding = (id) => { const b = brain.sources[id]?.binding; return b && b.owner_host_id === hostId && b.state === "active" ? b : null; };
if (cmd === "--help") { console.log("Commands:\\n  import <dir>   Import"); process.exit(0); }
if (cmd === "import") {
  const dir = args[1];
  const source = flag("--source-id") ?? "default";
  if (!brain.sources[source]) { console.error("Source not found: " + source); process.exit(1); }
  if (env.FAKE_COPY_STAGE) fs.cpSync(dir, env.FAKE_COPY_STAGE, { recursive: true });
  const binding = managed && source !== "default" ? ownBinding(source) : null;
  const refused = managed && source !== "default" && !binding;
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith(".md")) files.push(path.relative(dir, p));
    }
  })(dir);
  if (env.FAKE_POISON && files.some((f) => f.includes(env.FAKE_POISON))) {
    console.error("  (suppressing further errors)");
    console.log(JSON.stringify({ status: "partial", imported: 0, skipped: files.length, errors: 1, unchanged: files.length - 1, failures: [], source_id: source, total_files: files.length }));
    process.exit(1);
  }
  let imported = 0, skipped = 0, errors = 0;
  const failures = [];
  for (const rel of files) {
    if (env.FAKE_FAIL && rel.includes(env.FAKE_FAIL)) {
      // Before 0.48.5.0 a returned per-file failure counted only as skipped (exit 0).
      skipped++; if (env.FAKE_OLD_JSON !== "1") errors++;
      failures.push({ path: rel, error: "Invalid YAML frontmatter" });
      console.error("  Skipped " + rel + ": Invalid YAML frontmatter");
      continue;
    }
    if (refused) {
      skipped++; errors++;
      failures.push({ path: rel, error: "Managed import must run on the active canonical owner for the selected source." });
      continue;
    }
    if (env.FAKE_PENDING && rel.includes(env.FAKE_PENDING)) {
      skipped++;
      console.error("  Pending: " + rel + " was accepted and is still publishing; rerun to confirm it.");
      continue;
    }
    const body = fs.readFileSync(path.join(dir, rel), "utf8");
    const sha = (body.match(/^gstack_content_sha256: (\\S+)$/m) || [])[1] ?? null;
    const slug = rel.replace(/\\.md$/, "").toLowerCase();
    brain.pages[source] ??= {};
    if (brain.pages[source][slug]?.sha === sha) skipped++; else imported++;
    brain.pages[source][slug] = { sha };
    if (binding) {
      const target = path.join(binding.local_path, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }
  }
  save();
  const report = env.FAKE_OLD_JSON === "1"
    ? { status: "success", imported, skipped, errors, total_files: files.length }
    : { status: errors ? "partial" : "success", imported, skipped, errors, unchanged: skipped - failures.length, malformed_skipped: 0, failures, source_id: source, total_files: files.length };
  console.log(JSON.stringify(report));
  process.exit(errors ? 1 : 0);
}
if (cmd === "list") {
  busy();
  const source = env.FAKE_LIST_UNSCOPED === "1" ? undefined : flag("--source-id");
  if (source !== undefined && !brain.sources[source]) { console.error("Source not found: " + source); process.exit(1); }
  const slugs = Object.entries(brain.pages).filter(([s]) => source === undefined || s === source).flatMap(([, p]) => Object.keys(p));
  console.log(slugs.length ? slugs.map((s) => s + "\\ttranscript\\t2026-10-03\\t" + s).join("\\n") : "No pages found.");
  process.exit(0);
}
if (cmd === "get") {
  busy();
  const source = flag("--source-id") ?? "default";
  const page = brain.pages[source]?.[args[1]];
  if (!page) { console.error("Page not found: " + args[1]); process.exit(1); }
  console.log(JSON.stringify({ slug: args[1], source_id: source, frontmatter: page.sha ? { gstack_content_sha256: page.sha } : {} }));
  process.exit(0);
}
if (cmd === "sources" && args[1] === "list") {
  console.log(JSON.stringify({ sources: Object.entries(brain.sources).map(([id, s]) => ({ id, federated: s.federated, local_path: s.local_path ?? null, page_count: Object.keys(brain.pages[id] ?? {}).length })) }));
  process.exit(0);
}
if (cmd === "sources" && args[1] === "writer" && args[2] === "status" && managed) {
  const bindings = Object.entries(brain.sources).filter(([, s]) => s.binding).map(([id, s]) => ({
    source_id: id, relative_path: "", owner_host_id: s.binding.owner_host_id, state: s.binding.state,
    local_path: s.binding.owner_host_id === hostId ? s.binding.local_path : null,
  }));
  console.log(JSON.stringify({ enabled: true, mode: "managed", local_host_id: hostId, bindings }));
  process.exit(0);
}
if (cmd === "sources" && args[1] === "add") {
  if (env.FAKE_NO_SOURCES === "1") { console.error("Unknown command: sources add"); process.exit(2); }
  const id = args[2];
  const localPath = flag("--path");
  const existing = brain.sources[id];
  if (existing && (!managed || !localPath || existing.local_path || existing.binding)) {
    console.error("Error [source_id_taken]: Source ID is already registered."); process.exit(1);
  }
  if (managed && localPath && !args.includes("--force") && !fs.existsSync(path.join(localPath, ".git"))) {
    console.error("Error [not_a_git_repo]: The source path must contain committed Git content."); process.exit(1);
  }
  brain.sources[id] = { ...existing, federated: existing ? existing.federated : args.includes("--federated"),
    ...(localPath ? { local_path: localPath } : {}),
    ...(managed && localPath ? { binding: { owner_host_id: hostId, local_path: localPath, state: "active" } } : {}) };
  save();
  console.log("Source added: " + id);
  process.exit(0);
}
console.error("Unknown command: " + cmd);
process.exit(2);
`);
  chmodSync(join(binDir, "gbrain"), 0o755);
  return { binDir, brainFile, callLog };
}

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// Each engine revision and patch set gets a separate, disposable build checkout.
export function prepareEngineSource(desktop) {
  const lock = JSON.parse(readFileSync(path.join(desktop, "engine.lock.json"), "utf8"));
  if (!/^[a-f0-9]{40}$/.test(lock.revision) || lock.schemaVersion !== 1) {
    throw new Error("Invalid engine revision or unsupported snapshot schema in engine.lock.json");
  }
  const patches = lock.patches.map((patch) => {
    const file = path.resolve(desktop, patch.file);
    if (!file.startsWith(path.resolve(desktop) + path.sep)) throw new Error("Engine patch must be inside this repository");
    const bytes = readFileSync(file);
    if (createHash("sha256").update(bytes).digest("hex") !== patch.sha256) {
      throw new Error(`Engine patch checksum mismatch: ${patch.file}`);
    }
    return file;
  });
  const fingerprint = createHash("sha256").update(JSON.stringify(lock)).digest("hex");
  const cache = path.join(desktop, ".engine");
  const source = path.join(cache, fingerprint);
  if (existsSync(source)) {
    const tree = readFileSync(path.join(source, ".git", "rustnet-tree"), "utf8").trim();
    if (git(source, ["rev-parse", "HEAD"]) !== lock.revision ||
        git(source, ["write-tree"]) !== tree ||
        git(source, ["diff", "--name-only"]).length ||
        git(source, ["ls-files", "--others", "--exclude-standard"]).length) {
      throw new Error(`Cached engine sources changed. Preserve your edits, then remove ${source} and retry.`);
    }
    return source;
  }
  mkdirSync(cache, { recursive: true });
  const staging = mkdtempSync(path.join(cache, "fetch-"));
  try {
    console.log(`Fetching RustNet engine ${lock.revision}`);
    git(staging, ["init", "--quiet"]);
    git(staging, ["remote", "add", "origin", lock.repository]);
    git(staging, ["fetch", "--depth=1", "origin", lock.revision]);
    git(staging, ["checkout", "--detach", "--quiet", lock.revision]);
    for (const patch of patches) git(staging, ["apply", "--index", patch]);
    writeFileSync(path.join(staging, ".git", "rustnet-tree"), git(staging, ["write-tree"]) + "\n");
    renameSync(staging, source);
    return source;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

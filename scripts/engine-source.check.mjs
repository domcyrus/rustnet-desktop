import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareEngineSource } from "./engine-source.mjs";

test("pinned engine includes new patch files, reuses cache, and rejects changed sources or patches", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "rustnet-source-test-"));
  try {
    const upstream = path.join(temp, "upstream");
    const desktop = path.join(temp, "desktop");
    mkdirSync(upstream); mkdirSync(desktop);
    const git = (...args) => execFileSync("git", args, { cwd: upstream, encoding: "utf8" }).trim();
    git("init", "--quiet");
    writeFileSync(path.join(upstream, "original.txt"), "original\n");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "Fixture");
    const revision = git("rev-parse", "HEAD");
    const patch = "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+patched\n";
    const patchFile = path.join(desktop, "engine.patch");
    writeFileSync(patchFile, patch);
    writeFileSync(path.join(desktop, "engine.lock.json"), JSON.stringify({ repository: upstream, revision, schemaVersion: 1,
      patches: [{ file: "engine.patch", sha256: createHash("sha256").update(patch).digest("hex") }] }));
    const source = prepareEngineSource(desktop);
    assert.equal(readFileSync(path.join(source, "new.txt"), "utf8"), "patched\n");
    assert.equal(prepareEngineSource(desktop), source);
    writeFileSync(path.join(source, "new.txt"), "local edit\n");
    assert.throws(() => prepareEngineSource(desktop), /Cached engine sources changed/);
    assert.equal(readFileSync(path.join(source, "new.txt"), "utf8"), "local edit\n");
    writeFileSync(patchFile, patch + "tampered");
    assert.throws(() => prepareEngineSource(desktop), /checksum mismatch/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

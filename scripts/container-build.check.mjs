import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function fixture(t, failure = "") {
  const root = mkdtempSync(path.join(tmpdir(), "rustnet container test "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["scripts", "bin", "dist/linux"]) mkdirSync(path.join(root, directory), { recursive: true });
  const script = path.join(root, "scripts/build-container.sh");
  copyFileSync(new URL("./build-container.sh", import.meta.url), script);
  const log = path.join(root, "calls.jsonl");
  const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(args) + '\\n');
if (process.env.TEST_FAILURE === args[0]) process.exit(1);
if (args[0] === 'build') fs.writeFileSync(args[args.indexOf('--iidfile') + 1], 'sha256:built-image');
if (args[0] === 'create') process.stdout.write('export-container\\n');
if (args[0] === 'cp') {
  for (const name of ['rustnet-desktop', 'rustnet-capture-engine']) {
    if (process.env.TEST_FAILURE === 'missing' && name === 'rustnet-capture-engine') continue;
    const file = path.join(args[2], name);
    if (process.env.TEST_FAILURE === 'symlink' && name === 'rustnet-capture-engine') {
      fs.symlinkSync('rustnet-desktop', file);
    } else {
      fs.writeFileSync(file, 'new binary', { mode: 0o755 });
    }
  }
}
`;
  for (const runtime of ["docker", "podman"]) {
    const file = path.join(root, "bin", runtime);
    writeFileSync(file, fake);
    chmodSync(file, 0o755);
  }
  for (const name of ["rustnet-desktop", "rustnet-capture-engine"]) writeFileSync(path.join(root, "dist/linux", name), "previous binary");
  return {
    root,
    run: (args = []) => spawnSync("bash", [script, ...args], {
      cwd: tmpdir(), encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, TEST_LOG: log, TEST_FAILURE: failure },
    }),
    calls: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [],
  };
}

for (const runtime of ["docker", "podman"]) {
  test(`${runtime}: exports the exact build from another directory and cleans up`, (t) => {
    const f = fixture(t);
    const result = f.run(["--runtime", runtime, "--no-cache"]);
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls();
    assert.deepEqual(calls.map((args) => args[0]), ["build", "create", "cp", "rm"]);
    assert.ok(calls[0].includes("--no-cache"));
    assert.equal(calls[0].at(-1), f.root);
    assert.deepEqual(calls[1], ["create", "sha256:built-image"]);
    assert.deepEqual(calls[3], ["rm", "export-container"]);
    assert.equal(existsSync(path.dirname(calls[0][calls[0].indexOf("--iidfile") + 1])), false);
    for (const name of ["rustnet-desktop", "rustnet-capture-engine"]) assert.equal(readFileSync(path.join(f.root, "dist/linux", name), "utf8"), "new binary");
  });
}

for (const failure of ["build", "create", "cp", "missing", "symlink"]) {
  test(`${failure}: preserves previous binaries and removes the export container`, (t) => {
    const f = fixture(t, failure);
    assert.notEqual(f.run().status, 0);
    const calls = f.calls();
    assert.equal(calls.some((args) => args[0] === "rm"), !["build", "create"].includes(failure));
    assert.equal(existsSync(path.dirname(calls[0][calls[0].indexOf("--iidfile") + 1])), false);
    for (const name of ["rustnet-desktop", "rustnet-capture-engine"]) assert.equal(readFileSync(path.join(f.root, "dist/linux", name), "utf8"), "previous binary");
  });
}

test("invalid options fail before calling a container runtime", (t) => {
  const f = fixture(t);
  for (const args of [["--runtime"], ["--runtime", "unknown"], ["--unknown"]]) assert.equal(f.run(args).status, 2);
  assert.equal(f.run(["--help"]).status, 0);
  assert.deepEqual(f.calls(), []);
});

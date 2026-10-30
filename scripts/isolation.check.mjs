import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanEnvironment, sandboxRun, toolchain } from "./build-sandbox.mjs";
import { snapshot } from "./isolated-build.mjs";
import { sudoSession } from "./sudo-session.mjs";

test("authentication and launch happen only after a successful build", async () => {
  const steps = [];
  await sudoSession({
    build: async ({ afterBuild }) => { steps.push("build"); await afterBuild("/built/desktop"); steps.push("release lock"); },
    authenticate: () => steps.push("authenticate"),
    launch: (executable) => { assert.equal(executable, "/built/desktop"); steps.push("launch executable"); },
  });
  assert.deepEqual(steps, ["build", "authenticate", "launch executable", "release lock"]);
  steps.length = 0;
  await assert.rejects(sudoSession({
    build: async () => { throw new Error("build failed"); },
    authenticate: () => steps.push("authenticate"),
    launch: () => steps.push("launch"),
  }), /build failed/);
  assert.deepEqual(steps, []);
  await assert.rejects(sudoSession({
    build: async ({ afterBuild }) => afterBuild("/built/desktop"),
    authenticate: () => { throw new Error("authentication failed"); },
    launch: () => steps.push("launch"),
  }), /authentication failed/);
  assert.deepEqual(steps, []);
});

test("build environment does not inherit credentials or executable hooks", () => {
  const tools = { node: "/tools/node", pnpm: "/tools/pnpm", rust: "/tools/rust" };
  const env = cleanEnvironment("/private/build", tools, false);
  for (const name of ["SSH_AUTH_SOCK", "GH_TOKEN", "NODE_OPTIONS", "RUSTC_WRAPPER", "SUDO_UID", "RUSTNET_DEV_SUDO"]) assert.equal(env[name], undefined);
  assert.equal(env.CARGO_NET_OFFLINE, "true");
  assert.equal(env.HOME, "/private/build/home");
});

test("source snapshot includes edits but rejects external symlinks", () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "rustnet-snapshot-")));
  try {
    const source = path.join(directory, "source"), destination = path.join(directory, "copy");
    mkdirSync(source); mkdirSync(destination);
    execFileSync("git", ["init", "--quiet", source]);
    writeFileSync(path.join(source, "file"), "local edit");
    writeFileSync(path.join(source, ".npmrc"), "private registry credentials");
    execFileSync("git", ["add", "file", ".npmrc"], { cwd: source });
    writeFileSync(path.join(source, "untracked-secret"), "local secret");
    snapshot(source, destination);
    assert.equal(readFileSync(path.join(destination, "file"), "utf8"), "local edit");
    assert.equal(existsSync(path.join(destination, ".npmrc")), false);
    assert.equal(existsSync(path.join(destination, "untracked-secret")), false);
    symlinkSync(path.join(directory, "copy/file"), path.join(source, "escape"));
    execFileSync("git", ["add", "escape"], { cwd: source });
    assert.throws(() => snapshot(source, destination), /symlinks/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("OS sandbox blocks host files, subprocess escapes and offline networking", { skip: !["darwin", "linux"].includes(process.platform) }, async () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "rustnet-isolation-test-")));
  const root = path.join(directory, "sandbox"), secret = path.join(directory, "host-secret");
  const cache = path.join(directory, "cache");
  const server = createServer((socket) => socket.end());
  const agent = createServer((socket) => socket.end());
  try {
    for (const name of ["", "work", "home", "tmp"]) mkdirSync(path.join(root, name), { recursive: true, mode: 0o700 });
    for (const name of ["cargo", "pnpm-store", "target", "engine"]) mkdirSync(path.join(cache, name), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(cache, "control"), "host-only build control");
    writeFileSync(secret, "outside secret");
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const agentSocket = path.join(directory, "agent.sock");
    await new Promise((resolve) => agent.listen(agentSocket, resolve));
    const port = server.address().port;
    const tools = toolchain();
    const context = { root, cache, tools };
    const probe = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const cp = require('node:child_process');
      const net = require('node:net');
      assert.throws(() => fs.readFileSync(${JSON.stringify(secret)}));
      assert.throws(() => fs.readFileSync(${JSON.stringify(path.join(cache, "control"))}));
      assert.throws(() => fs.writeFileSync(${JSON.stringify(secret)}, 'changed'));
      assert.throws(() => cp.execFileSync('/bin/cat', [${JSON.stringify(secret)}], {stdio:'pipe'}));
      fs.writeFileSync(${JSON.stringify(path.join(root, "work/allowed"))}, 'allowed');
      fs.writeFileSync(${JSON.stringify(path.join(cache, "target/allowed"))}, 'allowed');
      assert.equal(process.env.SSH_AUTH_SOCK, undefined);
      assert.equal(process.env.RUSTNET_DEV_SUDO, undefined);
      if (process.platform === 'darwin') assert.throws(() => cp.execFileSync('/usr/bin/sudo', ['-n', '/usr/bin/true'], {stdio:'pipe'}));
      if (process.platform === 'darwin') assert.throws(() => cp.execFileSync('/bin/ps', ['eww', '-p', '${process.pid}', '-o', 'command='], {stdio:'pipe'}));
      if (process.platform === 'linux') assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /NoNewPrivs:\\s+1/);
      const socket = net.connect(${port}, '127.0.0.1');
      socket.on('connect', () => { socket.destroy(); process.exitCode = 1; });
      socket.on('error', () => {});
      socket.setTimeout(1000, () => socket.destroy());
    `;
    await sandboxRun(context, tools.node, ["-e", probe]);
    assert.equal(readFileSync(secret, "utf8"), "outside secret");
    assert.equal(readFileSync(path.join(root, "work/allowed"), "utf8"), "allowed");
    await sandboxRun({ ...context, online: true }, tools.node, ["-e", `
      const s = require('node:net').connect(${port}, '127.0.0.1');
      s.on('connect', () => s.destroy());
      s.on('error', () => { process.exitCode = 1; });
      s.setTimeout(2000, () => { s.destroy(); process.exitCode = 1; });
    `]);
    await sandboxRun({ ...context, online: true }, tools.node, ["-e", `
      const s = require('node:net').connect(${JSON.stringify(agentSocket)});
      s.on('connect', () => { s.destroy(); process.exitCode = 1; });
      s.on('error', () => {});
      s.setTimeout(1000, () => s.destroy());
    `]);
    await assert.rejects(sandboxRun(context, "/usr/bin/false", []), /No unsandboxed fallback/);
  } finally {
    server.close();
    agent.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

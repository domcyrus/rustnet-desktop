import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxRun, toolchain } from "./build-sandbox.mjs";

export const repository = fileURLToPath(new URL("..", import.meta.url));

export function snapshot(source, destination) {
  const names = execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: source }).toString().split("\0").filter(Boolean);
  for (const name of new Set(names)) {
    if (path.isAbsolute(name) || name.split("/").includes("..") || name.startsWith(".isolated-build/")) throw new Error(`Unsafe source path: ${name}`);
    if (name.split("/").some((part) => [".npmrc", ".netrc", "credentials", "credentials.toml"].includes(part) || part.startsWith(".env"))) continue;
    const input = path.join(source, name);
    if (!existsSync(input)) continue; // Deleted tracked files stay deleted.
    if (!lstatSync(input).isFile() || realpathSync(input) !== input) throw new Error(`Source symlinks and special files are not supported: ${name}`);
    const output = path.join(destination, name);
    mkdirSync(path.dirname(output), { recursive: true });
    copyFileSync(input, output);
  }
}

export async function isolatedBuild({ profile = "debug", phase = "all", afterBuild } = {}) {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("Isolated builds require macOS or Linux.");
  if (process.getuid() === 0) throw new Error("Run isolated builds as your normal user, never with sudo.");
  if (!["debug", "release"].includes(profile) || !["all", "fetch", "build"].includes(phase)) throw new Error("Invalid build profile or phase.");
  const cache = path.join(realpathSync(repository), ".isolated-build");
  for (const name of ["", "runs", "cargo", "pnpm-store", "target", "engine"]) {
    const directory = path.join(cache, name);
    if (existsSync(directory) && !lstatSync(directory).isDirectory()) throw new Error(`Unsafe isolation directory: ${directory}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  // Outside the sandbox's writable root, so build scripts cannot unlock it.
  const lock = path.join(realpathSync(repository), ".isolated-build.lock");
  mkdirSync(lock); // Reject concurrent builds, including an authenticated session.
  try {
    const tools = toolchain();
    const latest = path.join(cache, "latest-run");
    // Each run gets a new root. An older sandbox cannot race this host-side
    // snapshot by replacing writable directories from the previous run.
    const root = phase === "build" ? readFileSync(latest, "utf8") : mkdtempSync(path.join(cache, "runs/build-"));
    if (!root.startsWith(path.join(cache, "runs") + path.sep) || realpathSync(root) !== root) throw new Error("Invalid isolated source snapshot");
    const context = { root, cache, tools };
    if (phase !== "build") {
      const work = path.join(root, "work");
      for (const name of ["work", "home", "tmp"]) mkdirSync(path.join(root, name), { mode: 0o700 });
      snapshot(realpathSync(repository), work);
      symlinkSync(path.join(cache, "engine"), path.join(work, ".engine"), "dir");
      console.log("Fetching locked dependencies inside the sandbox, with lifecycle scripts disabled.");
      await sandboxRun({ ...context, online: true }, tools.node, ["scripts/isolated-phase.mjs", "fetch", profile]);
      writeFileSync(latest, root, { mode: 0o600 });
    }
    if (phase !== "fetch") {
      console.log("Building and testing offline inside the sandbox. No sudo authentication is used.");
      await sandboxRun(context, tools.node, ["scripts/isolated-phase.mjs", "build", profile]);
      const executable = path.join(cache, "target", profile, "rustnet-desktop");
      if (!lstatSync(executable).isFile() || realpathSync(executable) !== executable) throw new Error("Invalid built desktop executable");
      console.log(`Built ${executable}`);
      if (afterBuild) await afterBuild(executable);
      return executable;
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--release", "--fetch-only", "--build-only"].includes(arg)) || (args.includes("--fetch-only") && args.includes("--build-only"))) {
    console.error("Usage: node scripts/isolated-build.mjs [--release] [--fetch-only | --build-only]");
    process.exitCode = 1;
  } else {
    try { await isolatedBuild({ profile: args.includes("--release") ? "release" : "debug", phase: args.includes("--fetch-only") ? "fetch" : args.includes("--build-only") ? "build" : "all" }); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}

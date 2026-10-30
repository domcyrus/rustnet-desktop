// Runs only inside the OS sandbox, with a private HOME and dependency stores.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { prepareEngineSource } from "./engine-source.mjs";

const [phase, profile = "debug"] = process.argv.slice(2);
const workspace = process.cwd();
const run = (command, args, cwd = workspace) => execFileSync(command, args, { cwd, stdio: "inherit" });
const target = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)[1];
if (phase === "fetch") {
  run("pnpm", ["fetch", "--ignore-scripts", "--ignore-pnpmfile"]);
  const engine = prepareEngineSource(workspace);
  for (const directory of [engine, path.join(workspace, "src-tauri")]) {
    run("cargo", ["fetch", "--locked", "--target", target], directory);
  }
} else if (phase === "build") {
  run("pnpm", ["install", "--offline", "--frozen-lockfile", "--ignore-pnpmfile"]);
  run(process.execPath, ["scripts/prepare-engine.mjs", ...(profile === "release" ? ["--release"] : [])]);
  run("pnpm", ["run", "build"]);
  run("pnpm", ["test"]);
  run("pnpm", ["run", "test:engine-source"]);
  run("cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--check"]);
  run("cargo", ["clippy", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--all-targets", "--", "-D", "warnings"]);
  run("cargo", ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml"]);
  // Use embedded assets, not Vite or a watcher, for the later authenticated run.
  const config = path.join(workspace, "isolated.tauri.json");
  writeFileSync(config, JSON.stringify({ build: { beforeBuildCommand: null } }));
  run("pnpm", ["exec", "tauri", "build", "--no-bundle", "--config", config, ...(profile === "debug" ? ["--debug"] : [])]);
} else {
  throw new Error(`Unknown isolation phase: ${phase}`);
}

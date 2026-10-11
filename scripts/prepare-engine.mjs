import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prepareEngineSource } from "./engine-source.mjs";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const release = process.argv.includes("--release");
const binaryOverride = process.env.RUSTNET_DESKTOP_ENGINE;
const sourceOverride = process.env.RUSTNET_ENGINE_SOURCE;
if (release && (binaryOverride || sourceOverride)) {
  throw new Error("Release bundles require the pinned engine. Unset RUSTNET_DESKTOP_ENGINE and RUSTNET_ENGINE_SOURCE.");
}
const target = process.env.TAURI_ENV_TARGET_TRIPLE ||
  execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)[1];
const suffix = target.includes("windows") ? ".exe" : "";
const destination = path.join(desktop, "src-tauri/binaries", `rustnet-capture-engine-${target}${suffix}`);
mkdirSync(path.dirname(destination), { recursive: true });
if (binaryOverride) {
  if (!path.isAbsolute(binaryOverride) || !existsSync(binaryOverride)) {
    throw new Error("RUSTNET_DESKTOP_ENGINE must be an absolute path to an existing compatible engine binary");
  }
  // Tauri requires the sidecar at build time. Debug capture uses the original path.
  if (path.resolve(binaryOverride) !== destination) copyFileSync(binaryOverride, destination);
} else {
  const source = sourceOverride ? path.resolve(sourceOverride) : prepareEngineSource(desktop);
  if (!existsSync(path.join(source, "Cargo.toml"))) throw new Error(`Missing engine Cargo.toml: ${source}`);
  const args = ["build", "--locked", "--bin", "rustnet", "--target", target];
  if (release) args.push("--release");
  execFileSync("cargo", args, { cwd: source, stdio: "inherit" });
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1"], {
    cwd: source, encoding: "utf8",
  }));
  copyFileSync(path.join(metadata.target_directory, target, release ? "release" : "debug", `rustnet${suffix}`), destination);
}
console.log(`Prepared RustNet capture engine for ${target}`);

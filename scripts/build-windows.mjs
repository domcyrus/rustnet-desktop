import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (process.platform !== "win32") throw new Error("This launcher builds Windows executables.");
const elevated = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  "[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"],
{ encoding: "utf8" }).trim();
if (elevated !== "False") throw new Error("Build and launch from a non-administrator terminal; the desktop elevates only its capture engine.");
if (process.env.RUSTNET_DESKTOP_ENGINE || process.env.RUSTNET_ENGINE_SOURCE) {
  throw new Error("Unset engine overrides to build the pinned Windows test executable.");
}
const desktop = fileURLToPath(new URL("..", import.meta.url));
const run = (args) => execFileSync(process.execPath, args, { cwd: desktop, stdio: "inherit" });

// Build as a normal user. The finished desktop requests UAC for capture only.
run(["scripts/prepare-engine.mjs"]);
run(["node_modules/typescript/bin/tsc", "--noEmit"]);
run(["node_modules/vite/bin/vite.js", "build"]);
run(["node_modules/@tauri-apps/cli/tauri.js", "build", "--debug", "--no-bundle",
  "--config", JSON.stringify({ build: { beforeBuildCommand: "" } })]);
console.log(`Run this executable from a normal PowerShell; Start capture requests UAC:\n${path.join(desktop, "src-tauri/target/debug/rustnet-desktop.exe")}`);

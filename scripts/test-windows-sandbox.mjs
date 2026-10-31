import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prepareEngineSource } from "./engine-source.mjs";

if (process.platform !== "win32") {
  console.log("Windows token and job-object tests require Windows; skipped.");
} else {
  const source = prepareEngineSource(fileURLToPath(new URL("..", import.meta.url)));
  execFileSync("cargo", ["test", "--locked", "--manifest-path", path.join(source, "Cargo.toml"),
    "-p", "rustnet-sandbox", "--lib"], { stdio: "inherit" });
  execFileSync("cargo", ["test", "--locked", "--manifest-path", path.join(source, "Cargo.toml"),
    "--lib", "windows_helper::tests"], { stdio: "inherit" });
}

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareEngineSource } from "./engine-source.mjs";

const source = prepareEngineSource(fileURLToPath(new URL("..", import.meta.url)));
for (const args of [
  ["fmt", "--all", "--", "--check"],
  ["clippy", "--locked", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings"],
  ["test", "--locked", "--workspace", "--all-features"],
]) {
  execFileSync("cargo", args, { cwd: source, stdio: "inherit" });
}

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "linux") {
  execFileSync("xvfb-run", ["-a", "cargo", "test", "--locked", "--manifest-path",
    "src-tauri/Cargo.toml", "application_icons::linux::tests", "--", "--include-ignored",
    "--test-threads=1"], { stdio: "inherit" });
} else if (process.platform !== "darwin") {
  console.log("Native application icon tests require macOS or Linux; skipped on this platform.");
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), "rustnet-icon-tests-"));
  try {
    const source = fileURLToPath(new URL("../src-tauri/macos/application-icons-tests.m", import.meta.url));
    const binary = path.join(temporary, "tests");
    execFileSync("xcrun", ["clang", "-fobjc-arc", "-Wall", "-Wextra", "-Werror",
      "-mmacosx-version-min=13.0", source, "-framework", "AppKit", "-o", binary], { stdio: "inherit" });
    execFileSync(binary, { stdio: "inherit", timeout: 30000 });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

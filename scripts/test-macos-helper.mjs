import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("macOS helper tests require macOS; skipped on this platform.");
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), "rustnet-helper-tests-"));
  try {
    const source = fileURLToPath(new URL("../src-tauri/macos/tests.m", import.meta.url));
    const binary = path.join(temporary, "tests");
    execFileSync("xcrun", ["clang", "-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror",
      "-Wno-deprecated-declarations", "-mmacosx-version-min=13.0", source, "-framework", "Foundation",
      "-framework", "Security", "-o", binary], { stdio: "inherit" });
    execFileSync(binary, { stdio: "inherit", timeout: 30000 });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

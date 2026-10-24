import { execFileSync } from "node:child_process";
import path from "node:path";

export function prepareMacosHelper(desktop, target, engine) {
  if (!target.endsWith("-apple-darwin")) return;
  const arch = target.startsWith("aarch64-") ? "arm64" : "x86_64";
  const source = path.join(desktop, "src-tauri/macos/daemon.m");
  const helper = path.join(desktop, "src-tauri/binaries", `rustnet-capture-helper-${target}`);
  execFileSync("xcrun", ["clang", "-fobjc-arc", "-fblocks", "-O2", "-Wall", "-Wextra", "-Werror",
    "-Wno-deprecated-declarations", "-arch", arch, "-mmacosx-version-min=13.0", source,
    "-framework", "Foundation", "-framework", "Security", "-o", helper], { stdio: "inherit" });
  // Stable identifiers survive Tauri's subsequent Developer ID signing of
  // sidecars. Ad-hoc signatures allow builds but cannot authorize the service.
  for (const [file, identifier] of [
    [engine, "rustnet-capture-engine"],
    [helper, "io.github.domcyrus.rustnet.desktop.capture-helper"],
  ]) {
    execFileSync("codesign", ["--force", "--sign", "-", "--identifier", identifier, file], { stdio: "inherit" });
  }
}

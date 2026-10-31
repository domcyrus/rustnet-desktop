import { execFileSync, spawn } from "node:child_process";
import { existingDebugBuild, isolatedBuild } from "./isolated-build.mjs";
import { sudoSession } from "./sudo-session.mjs";

const usage = "Usage: node scripts/desktop-sudo.mjs [--no-build]";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log(usage);
  process.exit(0);
}
if (args.length > 1 || args.some((arg) => arg !== "--no-build")) {
  console.error(usage);
  process.exit(1);
}
const noBuild = args.includes("--no-build");

if (process.platform !== "darwin" || process.getuid?.() === 0) {
  console.error("Run desktop:sudo on macOS as your normal user, without sudo before pnpm.");
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error("Run desktop:sudo from an interactive terminal so sudo can authenticate before launch.");
  process.exit(1);
}

try {
  await sudoSession({
    build: noBuild ? existingDebugBuild : isolatedBuild,
    authenticate: () => {
      // Build or validate existing artifacts before requesting authentication.
      console.log(`${noBuild ? "Using existing debug build." : "Build complete."} Authenticate capture with sudo; only the desktop starts next.`);
      execFileSync("/usr/bin/sudo", ["-v"], { stdio: "inherit" });
    },
    launch: (executable) => new Promise((resolve, reject) => {
      const env = { ...process.env, RUSTNET_DEV_SUDO: "1" };
      // The isolated build always uses the pinned engine beside the executable.
      delete env.RUSTNET_DESKTOP_ENGINE;
      delete env.RUSTNET_ENGINE_SOURCE;
      const child = spawn(executable, [], { stdio: "inherit", env });
      const stop = () => child.kill("SIGTERM");
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") resolve();
        else reject(new Error(`Desktop exited with ${signal || code}`));
      });
    }),
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

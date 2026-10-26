import { execFileSync, spawn } from "node:child_process";

if (process.platform !== "darwin" || process.getuid?.() === 0) {
  console.error("Run desktop:sudo on macOS as your normal user, without sudo before pnpm.");
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error("Run desktop:sudo from an interactive terminal so sudo can authenticate there.");
  process.exit(1);
}

try {
  console.log("Authenticate capture with sudo. The desktop and build tools stay unprivileged.");
  execFileSync("/usr/bin/sudo", ["-v"], { stdio: "inherit" });
} catch {
  console.error("Sudo authentication failed; the desktop was not started.");
  process.exit(1);
}

// Refresh only this terminal's existing credential while the dev session lives.
// Never request passwords through the capture protocol or change sudoers.
const refresh = setInterval(() => {
  try {
    execFileSync("/usr/bin/sudo", ["-n", "-v"], { stdio: "ignore", timeout: 5000 });
  } catch {
    clearInterval(refresh);
    console.error("Sudo credentials expired. Restart pnpm run desktop:sudo to authenticate again.");
  }
}, 60000);

const child = spawn("pnpm", ["run", "desktop"], {
  stdio: "inherit",
  env: { ...process.env, RUSTNET_DEV_SUDO: "1" },
});
// Terminal signals also reach the child. Stay alive until it has shut down.
const interrupt = () => {};
const terminate = () => child.kill("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
function finish(code) {
  clearInterval(refresh);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
  process.exitCode = code;
}
child.on("error", (error) => { console.error(error.message); finish(1); });
child.on("exit", (code, signal) => finish(code ?? (signal === "SIGINT" ? 130 : 1)));

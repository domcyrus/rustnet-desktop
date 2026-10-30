import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function findTool(name) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (directory && existsSync(path.join(directory, name))) return realpathSync(path.join(directory, name));
  }
  throw new Error(`Required tool not found: ${name}`);
}

export function toolchain() {
  const cargo = realpathSync(execFileSync(findTool("rustup"), ["which", "cargo"], { encoding: "utf8" }).trim());
  const pnpm = findTool("pnpm");
  let pnpmRoot = path.dirname(pnpm);
  for (let directory = pnpmRoot; directory !== path.dirname(directory); directory = path.dirname(directory)) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "pnpm") { pnpmRoot = directory; break; }
  }
  let developer;
  if (process.platform === "darwin") {
    developer = realpathSync(execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8" }).trim());
    if (developer.endsWith("/Contents/Developer")) developer = path.dirname(path.dirname(developer));
  }
  return { rust: path.dirname(path.dirname(cargo)), node: realpathSync(process.execPath), pnpm, pnpmRoot, developer };
}

export function cleanEnvironment(root, tools, online, cache = root) {
  return {
    HOME: path.join(root, "home"),
    TMPDIR: path.join(root, "tmp"),
    XDG_CACHE_HOME: path.join(root, "home/cache"),
    XDG_CONFIG_HOME: path.join(root, "home/config"),
    XDG_DATA_HOME: path.join(root, "home/data"),
    XDG_RUNTIME_DIR: path.join(root, "tmp"),
    CARGO_HOME: path.join(cache, "cargo"),
    CARGO_TARGET_DIR: path.join(cache, "target"),
    CARGO_NET_OFFLINE: online ? "false" : "true",
    CARGO_INCREMENTAL: "0",
    PATH: [path.join(tools.rust, "bin"), path.dirname(tools.node), path.dirname(tools.pnpm), "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin"].join(":"),
    CI: "true",
    LANG: "en_US.UTF-8",
    OPENSSL_CONF: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "commit.gpgsign",
    GIT_CONFIG_VALUE_1: "false",
    PNPM_CONFIG_STORE_DIR: path.join(cache, "pnpm-store"),
    npm_config_userconfig: "/dev/null",
    npm_config_globalconfig: "/dev/null",
    PNPM_CONFIG_IGNORE_PNPMFILE: "true",
    PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: "false",
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "error",
  };
}

export function readRoots(tools, platform = process.platform) {
  const roots = [tools.rust, path.dirname(tools.node), tools.pnpmRoot || path.dirname(tools.pnpm)];
  if (platform === "darwin") {
    if (tools.developer) roots.push(tools.developer);
    roots.push("/System", "/usr", "/bin", "/sbin", "/Library/Developer", "/Library/Apple",
      "/opt/homebrew/Cellar", "/opt/homebrew/opt", "/opt/homebrew/lib", "/opt/homebrew/include", "/opt/homebrew/share",
      "/opt/homebrew/etc/ca-certificates/cert.pem",
      "/private/etc/ssl", "/private/etc/hosts", "/private/etc/resolv.conf", "/private/etc/localtime",
      "/private/var/db/xcode_select_link");
  } else {
    roots.push("/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/ssl", "/etc/ld.so.cache",
      "/etc/ld.so.conf", "/etc/ld.so.conf.d", "/etc/fonts", "/etc/alternatives",
      "/etc/hosts", "/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group");
  }
  return [...new Set(roots.filter(existsSync).map((root) => path.resolve(root)))];
}

export function seatbeltProfile(root, roots, online, caches = []) {
  const literal = (value) => JSON.stringify(value);
  return `(version 1)
(deny default)
(allow process-fork process-exec)
(deny process-exec (literal "/usr/bin/sudo") (literal "/usr/bin/su"))
(allow signal (target self) (target same-sandbox))
(allow sysctl-read)
(allow system-info)
(allow file-read-metadata)
(allow file-read* (literal "/"))
(allow file-read* file-write* (subpath ${literal(root)}))
${caches.map((directory) => `(allow file-read* file-write* (subpath ${literal(directory)}))`).join("\n")}
${roots.map((directory) => `(allow file-read* (subpath ${literal(directory)}))`).join("\n")}
(allow file-read* file-write* (literal "/dev/null") (literal "/dev/zero"))
(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))
(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.logd"))
${online ? `(allow network-outbound (remote ip "*:*"))
(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
(allow mach-lookup (global-name "com.apple.trustd") (global-name "com.apple.mDNSResponder"))` : ""}
`;
}

export function bubblewrapArgs(root, roots, online, cwd, caches = []) {
  const args = ["--die-with-parent", "--new-session", "--unshare-all"];
  if (online) args.push("--share-net");
  args.push("--cap-drop", "ALL", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  for (const directory of roots) args.push("--ro-bind", directory, directory);
  for (const directory of caches) args.push("--bind", directory, directory);
  args.push("--bind", root, root, "--chdir", cwd, "--");
  return args;
}

export async function sandboxRun({ root, cache = root, tools, online = false, cwd = path.join(root, "work") }, command, args) {
  const platform = process.platform;
  if (!["darwin", "linux"].includes(platform)) throw new Error("Isolated builds require macOS or Linux.");
  const policy = mkdtempSync(path.join(tmpdir(), "rustnet-build-policy-"));
  try {
    const roots = readRoots(tools);
    const caches = cache === root ? [] : ["cargo", "pnpm-store", "target", "engine"].map((name) => path.join(cache, name));
    let executable, parameters;
    if (platform === "darwin") {
      executable = "/usr/bin/sandbox-exec";
      const file = path.join(policy, "build.sb");
      writeFileSync(file, seatbeltProfile(root, roots, online, caches), { mode: 0o600 });
      parameters = ["-f", file, command, ...args];
    } else {
      executable = findTool("bwrap");
      parameters = [...bubblewrapArgs(root, roots, online, cwd, caches), command, ...args];
    }
    await new Promise((resolve, reject) => {
      const child = spawn(executable, parameters, {
        cwd, env: cleanEnvironment(root, tools, online, cache), detached: true,
        // No inherited terminal, SSH agent, sockets, or credential descriptors.
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.pipe(process.stdout, { end: false });
      child.stderr.pipe(process.stderr, { end: false });
      const killGroup = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } };
      const interrupted = () => killGroup();
      const cleanup = () => {
        process.removeListener("SIGINT", interrupted);
        process.removeListener("SIGTERM", interrupted);
      };
      process.on("SIGINT", interrupted);
      process.on("SIGTERM", interrupted);
      child.on("error", (error) => { cleanup(); reject(error); });
      child.on("exit", () => {
        // A build must not leave background tools running into authentication.
        killGroup();
        cleanup();
      });
      child.on("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`Isolated command failed (${signal || code}). No unsandboxed fallback: ${command}`)));
    });
  } finally {
    rmSync(policy, { recursive: true, force: true });
  }
}

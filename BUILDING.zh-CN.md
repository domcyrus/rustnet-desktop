# 隔离构建（未发布）

[English](BUILDING.md) | [简体中文](BUILDING.zh-CN.md) | [日本語](BUILDING.ja.md)

若要为 Arch Linux 构建，且不在宿主机安装 Node.js、pnpm 或 Rust，请使用下方的[容器构建](#arch-linux-容器构建)。

此流程在 macOS 或 Linux 上限制依赖脚本、构建工具和测试对宿主机的访问。先安装常规平台依赖、通过 rustup 安装的 Rust、Node.js，以及 `package.json` 固定版本的 pnpm。这些工具和仓库中的启动脚本属于可信输入。Linux 还需要 Bubblewrap（Debian/Ubuntu 可运行 `sudo apt-get install bubblewrap`），并支持非特权用户命名空间。macOS 需要系统的 `sandbox-exec`。此流程不支持 Windows。

在启用 AppArmor 用户命名空间限制的 Ubuntu 上，还需管理员启用发行版提供的 `bwrap-userns-restrict` 配置（Ubuntu 24.04 由 `apparmor-profiles` 提供）。参见 [Ubuntu 命名空间说明](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007)。启动器不会修改系统策略或禁用 AppArmor；命名空间初始化失败会停止构建。

在仓库目录执行，无需先运行 `pnpm install`：

```sh
node scripts/isolated-build.mjs
```

桌面调试构建会优化 `serde_json` 依赖，以降低大型快照的验证开销。调试断言、调试符号和仅限调试构建的 sudo 抓包启动器仍保持启用。

启动器把 Git 已跟踪文件复制到 `.isolated-build/runs/build-*/work`，保留本地修改，但拒绝符号链接和特殊文件。构建前请用 `git add` 暂存新增源码；未跟踪文件不会复制。常见凭据文件（`.npmrc`、`.netrc`、`.env*`、`credentials` 和 `credentials.toml`）即使已跟踪也会排除。请勿把其他秘密信息提交为构建输入。它使用独立的 HOME、临时目录、pnpm 存储、Cargo 缓存及构建输出目录。沙箱无法访问原始检出目录、Git 元数据、常规缓存、SSH agent、签名密钥及环境变量中的凭据。系统工具和所选 Rust 工具链可读但不可写；工作副本和专用缓存可写。

下载阶段允许联网，下载锁定的 pnpm 依赖，禁用生命周期脚本和 pnpmfile 钩子，获取固定的引擎版本并验证补丁哈希，然后执行 `cargo fetch --locked`。此流程不支持私有仓库或需要认证的 registry。下载阶段允许网络访问，并未限制为特定域名。

构建阶段在操作系统层面禁止联网，从专用存储离线安装依赖，运行显式批准的依赖构建脚本，构建引擎和前端，运行前端及 Rust 测试、格式检查和 Clippy，最后构建包含内嵌前端资源的桌面程序。Cargo 也使用离线模式。macOS 使用 Seatbelt 配置；Linux 使用 Bubblewrap 的挂载、PID、用户及网络命名空间，移除 capabilities 并禁止获取新权限。沙箱不可用时直接失败，不会自动退回普通构建。这是构建沙箱，不是运行中的桌面程序沙箱。

可执行文件和抓包引擎输出到 `.isolated-build/target/debug/`，命令会打印程序路径，但不会打开界面或开始抓包。添加 `--release` 可生成优化构建，输出到 `.isolated-build/target/release/`。此流程只构建可执行文件，不生成安装包或签名、公证包。现有 `pnpm run bundle` 仍是独立的普通打包流程。

也可分开执行两个阶段：

```sh
node scripts/isolated-build.mjs --fetch-only
node scripts/isolated-build.mjs --build-only
```

`--build-only` 使用上次下载时的源码快照，不包含之后的检出目录修改；缺少依赖时会离线失败。普通调用重新复制源码，仅复用专用缓存。确认没有构建或启动的桌面程序运行后，可删除 `.isolated-build/` 以清空缓存。`.isolated-build.lock/` 阻止并发构建及 sudo 会话；强制终止后，只有确认旧会话已退出才能删除该锁。

## Arch Linux 容器构建

Dockerfile 使用 Arch Linux 软件包生成优化的 x86_64 Linux 可执行文件。构建宿主机只需 Docker（使用当前默认的 BuildKit）或 Podman，以及 Bash 和标准 Unix 工具，无需安装 Node.js、pnpm、Rust 或 Bubblewrap。在仓库目录执行：

```sh
./scripts/build-container.sh
```

脚本构建镜像，使用本次构建的确切结果创建停止状态的容器，将两个二进制复制到 `dist/linux/`，然后删除临时容器。通过脚本路径调用时，可从任意目录运行。构建或提取失败会保留已有二进制。请将 `dist/linux/rustnet-desktop` 和 `dist/linux/rustnet-capture-engine` 放在同一目录。最终镜像仅包含这两个可执行文件，用于提取，不用于 `docker run`，脚本不会启动程序。也可通过 `docker build --pull --output type=local,dest=dist/container .` 直接导出，文件位于 `dist/container/out/`。

使用 rootless Podman 时，运行 `./scripts/build-container.sh --runtime podman`，不要使用 sudo。Docker 也支持 [rootless 模式](https://docs.docker.com/engine/security/rootless/)。现有 rootful Docker 可以使用，但其守护进程仍拥有宿主机 root 权限。本流程不会配置容器运行时或修改宿主机策略。

### 容器隔离

Docker/Podman 提供构建沙箱，无需嵌套 Bubblewrap 或使用特权模式。系统软件包和固定版本的 pnpm 以容器 root 身份安装。项目依赖下载、编译和测试以非特权 `builder` 用户运行，并启用 `no_new_privs`。`.dockerignore` 白名单仅发送构建输入，排除 Git 元数据、宿主机缓存和常见凭据文件。构建前请检查允许的源码目录，写入源码的秘密信息仍属于构建输入。构建步骤不会挂载宿主机目录、Docker socket、SSH agent 或秘密信息。

下载阶段允许联网，验证引擎补丁哈希，下载锁定依赖，并禁用 pnpm 生命周期脚本和 pnpmfile 钩子。编译和测试使用 `RUN --network=none`，pnpm 和 Cargo 均离线运行。导出前必须通过与本地隔离构建相同的前端测试、引擎源码测试、Rust 测试、格式检查和 Clippy。失败会停止构建，不要通过添加 `--privileged`、宿主机网络或不安全的构建授权绕过失败。

容器与宿主机共享内核，隔离不能证明二进制可信。Rootless Docker 或 Podman 可降低容器运行时权限；需要更强边界时请使用一次性虚拟机。基础镜像和 Arch 软件包持续更新，因此不保证逐位可复现。脚本始终使用 `--pull` 更新基础镜像；`./scripts/build-container.sh --no-cache` 还会重新安装软件包并执行全部构建步骤。仓库仍锁定 pnpm 依赖、Rust 依赖和引擎版本。

### 在 Arch Linux 上运行

构建架构必须与宿主机一致。本流程面向当前的 Arch Linux x86_64，不面向较旧发行版或 ARM。请更新宿主机，使运行时库与构建环境匹配：

```sh
sudo pacman -Syu --needed webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg libpcap libelf
sudo setcap cap_net_raw+eip dist/linux/rustnet-capture-engine
./dist/linux/rustnet-desktop
```

上述 capability 支持不使用 eBPF 的抓包。仅在提取可信构建后设置，替换引擎后需重新设置。界面以普通用户运行，Node.js 和 pnpm 不是运行时依赖，前端资源已内嵌。构建沙箱不限制启动后的桌面程序。其他引擎要求见[抓包权限](docs/GUIDE.zh-CN.md#抓包权限)。若窗口空白，可尝试 `WEBKIT_DISABLE_DMABUF_RENDERER=1 ./dist/linux/rustnet-desktop`。

## 构建完成后使用 sudo 抓包

在 macOS 交互式终端中，以普通用户执行：

```sh
node scripts/desktop-sudo.mjs
```

若要复用现有 debug 桌面程序和抓包引擎，不下载依赖、不编译也不运行测试：

```sh
node scripts/desktop-sudo.mjs --no-build
```

启动器会先检查 `.isolated-build/target/debug/` 中两个可执行文件，再请求 sudo 认证。文件缺失、不可执行或使用符号链接时会报错并提示重新构建，不会自动构建。桌面退出前始终持有同一个构建锁。此选项不检查二进制是否与当前源码一致；修改源码或依赖后请省略 `--no-build`。也支持 `pnpm run desktop:sudo --no-build`。

若项目依赖已经安装，也可使用别名 `pnpm run desktop:sudo`。直接使用 Node 无需预先普通安装依赖。默认情况下，启动器先完成隔离的 debug 构建和测试，仅在成功后请求 sudo 认证，然后直接运行包含内嵌资源的桌面程序。认证后不会启动 Vite、监视器、编译器或包管理器任务，也不会定期刷新 sudo 凭据。

选择 **Automatic** 后开始抓包。只有引擎通过 sudo 启动，界面保持普通用户权限。固定版本的引擎打开抓包后降权，并启用严格沙箱。指定接口会禁用 PKTAP。此流程不支持自定义引擎源码或二进制。无需注册辅助程序、签名、公证或修改 sudoers。发布构建仍忽略 `RUSTNET_DEV_SUDO`，使用 PKTAP 需要已签名的辅助程序。

sudo 凭据过期不影响已有抓包，但新的抓包可能失败。退出桌面后加上 `--no-build` 重新运行，以认证并复用原有构建。停止抓包或关闭桌面会完成录制写入。实际 PKTAP 抓包及已签名 SMAppService 部署仍需单独验证。

## 边界与检查

沙箱限制被入侵的构建对宿主机的影响，但不能证明产物可信。构建脚本可以修改工作副本、专用缓存和产物。不要运行来自不可信源码或依赖的产物，更不要为其提权。引擎在启用运行时沙箱之前仍有特权初始化阶段。构建时不会请求或刷新已有 sudo 凭据；macOS 策略阻止执行 sudo/su，Linux 沙箱禁止获取新权限。

macOS 自定义沙箱配置接口已弃用。缺失或不兼容会导致错误，不会允许无隔离执行。对于操作系统漏洞或确实不可信的源码，使用一次性虚拟机可提供更强边界。普通 `pnpm run desktop` 热重载流程不在此隔离范围内。

运行 `node --test scripts/isolation.check.mjs` 可验证真实文件系统和网络限制、子进程继承及先构建后认证的顺序。测试需在允许创建操作系统沙箱的环境中执行，外层沙箱可能阻止此操作。

PR 和向 `main` 的推送仅运行 Linux x64 构建、测试、安全审计和隔离检查。GitHub 稳定版发布以及手动运行 **Desktop** 工作流时，还会运行 macOS 隔离检查、macOS 辅助程序测试与打包，以及 Windows 检查。预发布版本不会触发此工作流。发布稳定版之前，可手动运行工作流以检查所有平台。

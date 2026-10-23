# RustNet 桌面界面（尚未发布）

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

基于 Tauri 2 的 RustNet 桌面前端。应用视图、连接表、详情面板和流量图使用真实的
第 1 版无界面 JSON 快照；应用不会显示模拟流量。

## 开发

安装 Rust、Node.js 22.13+（或更新的受支持 LTS）、现有 RustNet 构建依赖，以及
[Tauri 桌面依赖](https://v2.tauri.app/start/prerequisites/)。Linux 还需要
WebKitGTK 4.1 和 GTK 3 开发包；Windows 需要 MSVC、WebView2 和 Npcap。
请在目标平台上构建。安装 [pnpm](https://pnpm.io/installation) 12.12.0
（版本固定在 `package.json`），例如运行 `npm install --global pnpm@12.12.0`。
在此目录运行：

```sh
pnpm install --frozen-lockfile
pnpm run desktop
```

本仓库包含桌面 UI、Tauri 桥接层和打包配置。抓包引擎和 TUI 保留在
[domcyrus/rustnet](https://github.com/domcyrus/rustnet)。构建需要 Git。首次启动会获取
`engine.lock.json` 固定的引擎提交，验证并应用列出的补丁，构建 CLI 并复制到
`src-tauri/binaries`。源码缓存在 `.engine/`，不需要相邻的 RustNet 检出目录。
单独运行 `pnpm run dev` 只能预览布局；抓包功能需要 Tauri。

### 引擎开发与更新

此私有仓库暂时通过 `engine/patches/0001-desktop-integration.patch` 保存尚未合入上游的
接口发现、受控关闭、历史连接、丰富元数据和抓包覆盖统计等改动。原始改动仍保留在
RustNet 检出目录，供单独审查。合入上游后，将 `engine.lock.json` 更新到相应提交，
并删除补丁条目及文件。每个补丁均有 SHA-256 校验值，修改补丁时必须更新锁文件。
桌面使用快照 schema 1，并允许新增字段。更新引擎时必须通过下方的前端验证和 Rust
桥接测试。补丁只是临时集成措施，不是另一套引擎实现。

桌面会显式启用 `--headless-details full` 和 `--capture-accounting`。
普通无界面运行保持上游 schema，并跳过额外的详细字段构建和覆盖统计。
覆盖统计复用进程运行期间累计的抓包字节计数，每个处理批次发布一次已跟踪和已归属的帧字节总数。
归属以处理数据包时的进程信息为准；之后发现的进程不会修改历史总数。
debug 引擎覆盖必须支持这两个选项。更新后请重新构建旧的捆绑引擎。

开发引擎时，在运行 `pnpm run desktop` 前将 `RUSTNET_ENGINE_SOURCE` 设置为包含上述
改动的 RustNet 检出目录。脚本只构建，不应用补丁或修改其 Git 状态。
也可以通过 `RUSTNET_DESKTOP_ENGINE` 使用已有的兼容二进制并跳过引擎构建。
两种覆盖仅支持 debug；发布包必须使用固定版本。若缓存源码被修改，脚本会报错而不会
重置。删除 `.engine/` 重新获取之前，请保存自己的改动。

## GeoIP 数据库

引擎会在 `~/.local/share/rustnet/geoip/`（或
`$XDG_DATA_HOME/rustnet/geoip/`）及标准系统目录中查找 GeoLite2 数据库。
将 `GeoLite2-Country.mmdb`、`GeoLite2-ASN.mmdb` 和可选的
`GeoLite2-City.mmdb` 放在这里，即可与 TUI 共用。仅位于终端当前工作目录的
数据库可能无法被桌面应用发现。

也可以打开抓包设置，点击 **Choose GeoIP folder**，选择包含这些文件的目录；
允许只提供其中部分数据库。应用会记住选择，并将数据库绝对路径传给引擎。
抓包期间点击 **Apply and restart capture**，或重新开始抓包以加载数据库。
**Use automatic discovery** 恢复引擎默认搜索。无需下载数据库或提升桌面应用权限。
若查询无结果（例如缺少城市数据），相应字段仍显示 Unavailable。

## 抓包权限

使用普通用户运行桌面应用，仅抓包引擎需要抓包权限。桌面不会调用 sudo、安装防火墙
规则或禁用引擎沙箱。

- **Linux：** 首次构建引擎后，按照 [INSTALL.md](https://github.com/domcyrus/rustnet/blob/main/INSTALL.md) 配置附带引擎的
  capabilities。在此目录中，不使用 eBPF 的抓包配置示例（按需替换目标三元组）：

  ```sh
  sudo setcap cap_net_raw+eip src-tauri/binaries/rustnet-capture-engine-x86_64-unknown-linux-gnu
  ```

  复制或重新构建会清除文件 capabilities。开发时可将 `RUSTNET_DESKTOP_ENGINE`
  设置为已配置权限、兼容的引擎绝对路径。此覆盖仅用于 debug 构建。
  打包版本使用相邻的附带引擎；权限配置是独立的安装步骤，不会自动执行。
- **macOS：** 按照 [INSTALL.md](https://github.com/domcyrus/rustnet/blob/main/INSTALL.md) 配置 BPF 访问权限。非 root 的 BPF
  抓包使用可用的进程归属回退方案。初版不安装具有特权的 PKTAP 辅助进程。
- **Windows：** 安装允许普通用户访问的 Npcap。若安装时限制为管理员访问，需要单独
  配置权限。
- **FreeBSD：** 现有 CLI 继续受支持；初版 Tauri 桌面应用不提供 FreeBSD 支持。

选择接口并点击 **Start capture**。权限、驱动和抓包错误会显示在界面中。
进程归属可能受到操作系统限制，无法归属的连接仍会显示。

## Linux 渲染故障排查

如果整个窗口无响应或调整大小后出现黑色区域，请在终端按 Ctrl+C 停止当前开发运行，然后尝试：

```bash
pnpm run desktop:linux-compat
```

此 Linux 专用命令仅为本次启动设置 `WEBKIT_DISABLE_DMABUF_RENDERER=1`，用于测试
[Tauri 文档中的 WebKitGTK 图形兼容方案](https://tauri-v2.netlify.app/develop/debug/linux-graphics/)。
它不会更改默认启动方式、抓包权限或沙箱，只需重启桌面应用，无需重新构建捕获引擎。
如果仍然卡住，请先收集终端输出以及 WebKitGTK 和显卡驱动版本，再尝试其他方案。
仅凭黑色区域无法确定具体原因。

## 视图与录制

- 检查器显示引擎提供的服务、VLAN、地址范围、数据包总数、进程祖先、父 PID、
  用户/组、容器/Kubernetes 元数据、主机名、观测到的邻居 MAC、GeoIP 和捕获 DNS 归属。
  协议字段与 TUI 共享定义，包括 TLS/SNI/ALPN 和密码套件。传输健康信息包含 RTT、
  TCP 计数器/窗口及协议请求结果。未知窗口缩放会标为原始值，未观测到的数据保持不可用。
  Linux 上，经过身份验证的启动快照匹配可保留沙箱启用前读取的可执行文件路径；
  新启动或无法访问的进程仍可能缺少路径。请重新构建内置引擎并重启捕获以获取新元数据。

- 顶部摘要、All traffic、应用列表和详情、连接速率统一使用活动连接字节计数器的两秒窗口，包含 Unattributed 流量。首次观察到的已有连接先建立基线，关闭的连接退出实时汇总。覆盖率和总体会话累计值仍使用原始帧计数，因此可与连接字节数不同。**Log scale** 可同时显示小流量与大突发。
- 实时速率使用两秒移动平均，**Show raw peaks** 显示原始区间速率。图表显示实际采样数量，在 60 秒内最多保留 121 个点；忽略时间过近的更新，但保留其字节增量。桥接快照无效时保留上一次有效视图，恢复后自动清除错误。
- Applications 默认选择 **All traffic**，显示总体流量图、已追踪下载/上传的会话累计量、
  连接/应用/主机数量和抓包覆盖情况。选择应用查看详情，点击 All traffic 返回。
  总体图不再位于 Connections。**Show breakdown graph** 比较捕获与已归属应用的速率。
- 覆盖统计使用包含链路层头部的原始捕获帧长度，分为已归属应用、应用未知的已追踪连接，
  以及未进入连接追踪的字节。归属以处理数据包时为准，后续不会回溯调整；连接过期不会
  删除累计量。追踪外差额包括待处理、跳过及队列丢弃的数据包，队列清空时可能减少。
  后端从未交付的数据包无法统计字节数，VPN/全接口抓包也可能重复观察流量。
  这些计数与单应用的连接字节累计量不同。重新构建引擎并重启抓包以启用；旧引擎会显示说明。
- 单击应用查看流量概览；双击应用打开 Connections，并按该应用分组精确筛选。
  点击 Clear filter 显示所有应用。筛选包含匹配的保留历史连接，并支持后退/前进导航。
- Connections 使用无分页的连续滚动表格。点击行内任意位置查看详情，双击直接展开。
  在应用下双击目标连接，也会直接打开展开的连接详情。
- 应用和连接默认按名称字母顺序排列，速率在原位置更新。点击连接的下载或上传列标题，
  或应用列表的 Download rate 标题可按当前速率排序；速率排序会实时更新。
- 应用详情显示活跃连接及仍被保留的已关闭连接的下载和上传字节总量。旧连接被移除时，
  总量可能减少，因此不是完整会话或应用生命周期的累计值。Hosts 按活跃连接的不同远端 IP
  计数，同一 IP 的不同端口只计为一个主机。
- 下拉菜单跟随外观主题。使用方向键、Home/End 或输入标签前缀导航；Enter 选择，
  Escape 取消，Tab 关闭菜单。
- 点击抓包状态旁的来源按钮打开抓包设置。Linux 在尚未保存偏好且可用时默认选择
  **All interfaces (any)**，同时保留 **Automatic (one interface)** 和指定接口选项。
  已保存的选择（包括 Automatic）会保留；已保存接口不可用时需手动选择替代接口。
  抓包期间点击 **Apply and restart capture**，会先正常停止旧会话，再启动新会话；
  录制需要使用新文件。
- 连接详情提供独立滚动的 Overview、Process 和 Protocol 内容。拖动分隔条或使用
  左右方向键调整宽度。**Expand** 打开专注视图；较小窗口会用详情替换列表。
  关闭详情或按 Escape 返回时保留筛选条件。
- 详情宽度保存在本地。实时速率在固定宽度的汇总区域中保持单行，避免流量变化导致布局跳动。
- 按进程名分组并列出相关 PID。缺失的可执行文件路径不会拆分分组，路径补全时也不会
  重置图表。同名但路径不同的已知程序保持独立并显示路径。有多个路径时，仅在活动 PID
  唯一对应某路径的情况下合并缺失路径的连接，否则保留在可执行文件不可用的分组中。
- 连接支持按进程、PID、主机名、IP、端口或协议搜索，以及流量和名称排序。
  刷新时保留所选连接的身份。此搜索是本地词语搜索，不是 TUI 的筛选表达式。
- 桌面通过 `--include-historic` 请求引擎保留的历史连接；History 按钮仅在本地切换显示，
  隐藏时仍显示历史记录数量。
- **History** (`t`) 显示仍被保留的历史连接。实时汇总不包含历史连接速率，
  仅涵盖活跃的已跟踪连接，不代表接口的全部字节或不可见流量。
- 图表为所有应用持续保留最近 60 秒的实际样本，切换应用时立即显示已有历史。
  新的抓包会话会清空历史。
  **Freeze view** 仅冻结显示，抓包和录制继续进行。
- 抓包来源旁的圆点表示正在抓包。点击来源控件打开抓包设置和 **Stop capture**。
  **Freeze view** 始终可直接使用。
- 开始前选择 **Record PCAPNG**，通过原生保存对话框选择尚不存在的文件名。
  使用引擎带注释的 PCAPNG 导出器；录制随抓包开始，不能追溯此前的流量。
  停止抓包以完成写入。导出错误或导出记录丢失表示文件可能不完整。
- 外观、首选视图和上次成功请求的接口保存在本地；界面不持久化流量快照。
- 宽详情面板同时显示 Overview、Process 和 Protocol；空间不足时使用选项卡。
- 鼠标后退/前进按钮和 Alt+左/右方向键可恢复之前的视图及选择。
- 沙箱状态和数据包计数位于左侧栏 Capture Source 上方。
- Connections 中，`g`/`G` 选择首行/末行，`Ctrl+f`/`Ctrl+b` 向下/向上移动一页，
  遵循当前筛选和排序。文本框和下拉菜单不会触发这些快捷键。
- 侧栏 **Help** 或 `h` 打开当前视图的帮助，说明相关快捷键和数据含义。
  抓包设置和连接详情也有各自的帮助。
- 空闲连接使用引擎的清理计时：超时过半后，信息列逐渐淡化并显示归档倒计时。
  有流量和选中行保持清晰；减少动态效果设置会关闭过渡。旧引擎仍支持历史记录，
  但需重新构建引擎才能显示清理计时。
- `/` 聚焦连接搜索；Escape 关闭详情或外观面板。

## 进程边界

桌面只通过结构化参数启动附带的 `rustnet-capture-engine`。`--list-interfaces` 返回 JSON，
不启动抓包。抓包使用 `--headless --output jsonl --include-historic --stop-on-stdin-close`。
控制管道关闭时，包括桌面崩溃后，CLI 请求正常关闭并刷新输出。关闭窗口会等待引擎
停止；15 秒后仍未退出的子进程会被终止，录制结果标记为可能不完整。

桥接层只保留最新快照，单条记录限制为 16 MiB，诊断输出有上限。界面每 500 ms
串行轮询并验证 schema 1。Connections 使用连续表格；应用及其目标列表每页显示 75 项。
数据包解析、进程查询、
降权及沙箱仍由原有引擎负责。Webview 没有 shell 或通用文件系统插件权限。
防火墙和进程终止操作不在初版范围内。

## 验证与打包

```sh
pnpm run prepare:engine
pnpm run build
pnpm test
pnpm run test:engine-source
pnpm run check:engine
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
pnpm audit
cargo audit --file src-tauri/Cargo.lock
pnpm run bundle
```

`pnpm run bundle` 构建 release CLI 和桌面程序，并将引擎包含在平台安装包中。
未配置生产签名、公证凭证和自动抓包权限配置。修改引擎时，还需在 RustNet 仓库执行
[CONTRIBUTING.md](https://github.com/domcyrus/rustnet/blob/main/CONTRIBUTING.md) 中的检查。

当前 Tauri 的 Linux 依赖树会报告上游 RustSec 警告，包括停止维护的 crate 和
GLib `VariantStrIter` 的健全性问题（RUSTSEC-2024-0429）。桌面检查不屏蔽这些警告；
发布生产版本前请评估上游修复情况。

## 依赖更新

GitHub Dependabot 每天检查仓库根目录的 pnpm 依赖、`src-tauri` 中的 Cargo 依赖
和 GitHub Actions。配置沿用 RustNet 的策略：按生态分组，包括主版本升级。包更新
默认等待 3 天，主版本等待 7 天、次版本 4 天、补丁版本 3 天。安全更新不受等待期
限制。合并前应审查 PR 和 CI 结果；未配置自动合并，无需安装外部应用。

`engine.lock.json` 和临时引擎补丁仍需一起手动维护，Dependabot 不会更新已应用
补丁的引擎提交版本。

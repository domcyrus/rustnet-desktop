# 使用与开发指南（尚未发布）

[English](GUIDE.md) | [简体中文](GUIDE.zh-CN.md) | [日本語](GUIDE.ja.md)

[返回项目介绍](../README.zh-CN.md)


**目录**

- [开发](#开发)
- [GeoIP 数据库](#geoip-数据库)
- [抓包权限](#抓包权限)
- [macOS sudo 开发模式](#macos-sudo-开发模式)
- [Linux 渲染故障排查](#linux-渲染故障排查)
- [视图与录制](#视图与录制)
- [进程边界](#进程边界)
- [验证与打包](#验证与打包)
- [依赖更新](#依赖更新)

## 开发

安装 Rust、Node.js 22.22.2+ 或 24.15.0+ LTS、现有 RustNet 构建依赖，以及
[Tauri 桌面依赖](https://v2.tauri.app/start/prerequisites/)。Linux 还需要
WebKitGTK 4.1 和 GTK 3 开发包；Windows 需要 MSVC、WebView2 和 Npcap。
请在目标平台上构建。安装 [pnpm](https://pnpm.io/installation) 12.15.0
（版本固定在 `package.json`），例如运行 `npm install --global pnpm@12.15.0 --allow-scripts=pnpm`。
macOS 构建要求 macOS 13+ 和 Xcode 命令行工具（`xcode-select --install`）。
在此目录运行：

macOS 和 Linux 可先运行 `node scripts/isolated-build.mjs`，无需预先安装项目依赖。
详情见[隔离构建及 sudo 抓包](../BUILDING.zh-CN.md)。以下为普通热重载开发流程：

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

捆绑引擎固定到 [RustNet #721](https://github.com/domcyrus/rustnet/pull/721) 的 `64fe320`，
其中已包含合入的 #719。共享 CLI 功能直接使用该提交。
唯一保留的引擎补丁 `engine/patches/0003-windows-capture-helper.patch` 提供桌面专用的
Windows 抓包协议及预先打开的录制和 GeoIP 文件句柄。该补丁、应用图标查找和 macOS
辅助程序均由桌面仓库维护。每个补丁都有 SHA-256 校验和，修改时必须更新锁文件。
桥接层接受 schema 2 和旧 schema 1，并向 UI 和历史存储提供保留新增字段的完整 schema 1
快照。引擎更新必须通过前端验证、Rust 桥接测试，以及对应平台的原生辅助程序和图标测试。

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

使用普通用户运行桌面应用，仅抓包引擎需要抓包权限。可选的 macOS 开发模式仅对引擎
调用 sudo。桌面不会安装防火墙规则或禁用引擎沙箱。

- **Linux：** 首次构建引擎后，按照 [INSTALL.md](https://github.com/domcyrus/rustnet/blob/main/INSTALL.md) 配置附带引擎的
  capabilities。在此目录中，不使用 eBPF 的抓包配置示例（按需替换目标三元组）：

  ```sh
  sudo setcap cap_net_raw+eip src-tauri/binaries/rustnet-capture-engine-x86_64-unknown-linux-gnu
  ```

  复制或重新构建会清除文件 capabilities。开发时可将 `RUSTNET_DESKTOP_ENGINE`
  设置为已配置权限、兼容的引擎绝对路径。此覆盖仅用于 debug 构建。
  打包版本使用相邻的附带引擎；权限配置是独立的安装步骤，不会自动执行。
- **macOS：** 使用 PKTAP 时，将已通过 Developer ID 签名和公证的应用安装到
  `/Applications`。打开抓包设置，选择 **Enable capture helper**，然后在
  **System Settings > General > Login Items & Extensions** 中批准 RustNet Desktop。
  点击 **Recheck helper status**，选择 **Automatic** 后开始抓包。
  `SMAppService` 辅助进程以 root 启动内置引擎；引擎打开抓包后降权至当前用户并启用
  严格沙箱，界面始终以普通用户运行。当前引擎选择指定接口时不使用 PKTAP。
  停止抓包后可点击 **Remove capture helper**。更新更改辅助程序或 launch-daemon plist 后，
  请移除并重新启用辅助程序。未启用 sudo 开发模式的开发和临时签名构建使用普通 BPF 抓包和 `lsof` 进程归属。
  按照 [INSTALL.md](https://github.com/domcyrus/rustnet/blob/main/INSTALL.md) 配置 BPF 权限；
  ChmodBPF 本身不授予 PKTAP 权限，辅助进程批准与 BPF 权限是独立的设置。
- **Windows：** 安装允许普通用户访问的 Npcap。若安装时限制为管理员访问，需要单独
  配置权限。
- **FreeBSD：** 现有 CLI 继续受支持；初版 Tauri 桌面应用不提供 FreeBSD 支持。

选择接口并点击 **Start capture**。权限、驱动和抓包错误会显示在界面中。
进程归属可能受到操作系统限制，无法归属的连接仍会显示。

## macOS sudo 开发模式

无需签名或公证即可使用 PKTAP，以普通用户执行：

```sh
node scripts/desktop-sudo.mjs
```

如需认证并复用现有 debug 构建，跳过编译和测试，请运行 `node scripts/desktop-sudo.mjs --no-build`。修改源码或依赖后请重新构建。

启动器先完成隔离的离线 debug 构建和测试，然后才请求 sudo 认证。
随后直接启动包含内嵌资源的桌面程序，不运行开发服务器或构建监视器。
选择 **Automatic** 后开始抓包。只有引擎使用 sudo，界面保持普通用户权限。
不会定期刷新凭据。前置条件、限制和重试说明见[隔离构建指南](../BUILDING.zh-CN.md)。
安装过依赖时，`pnpm run desktop:sudo` 仍可作为别名使用。

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

- **Applications** 默认打开 **All traffic**，显示总体图表、已追踪会话累计量、
  连接/应用/主机数量及抓包覆盖情况。单击应用查看详情，双击按该分组筛选 Connections。
  筛选包含匹配的保留历史连接；**Clear filter** 返回所有应用。
- **Connections** 是连续滚动的可搜索表格，可按进程、PID、主机名、IP、端口或协议
  进行词语搜索，不使用 TUI 筛选表达式。应用和连接默认按名称排序，点击速率标题可
  实时按速率排序。单击连接在行下方查看详情，再次单击或选择 Collapse 收起。
- 检查器显示进程祖先、用户/组、容器元数据、服务/VLAN、主机名、GeoIP、DNS、TLS
  和传输健康信息。未观测到的数据保持不可用。Linux 可保留启动时的可执行文件路径，
  但新启动或无法访问的进程可能缺少路径。
- Prism 在浅色和深色主题中采用淡紫色导航、简洁面板，以及紫色/青绿色流量标记。
  连接表分开显示应用/PID、目标/状态、下载和上传，便于点击速率排序标题。
- 连接详情在选中行下方展开。宽窗口同时以三列显示 Connection & traffic、Process
  和 Protocol & transport；窄窗口将这些内容纵向排列。**Show unobserved fields**
  显示未观测字段，已观测数据与零值计数默认可见。
- All traffic 将图表、会话总量和覆盖信息紧凑排列，应用列表保留在下方。测量说明按需展开。
  每个应用只显示一次名称，点击行上的箭头展开或收起详情。列表与详情共用一个滚动区域，
  导航与操作区固定。
  上下方向键、Page Up/Page Down、Home/End 滚动当前内容，即使焦点位于按钮上也有效，
  文本框和下拉菜单保留正常按键行为。Collapse 将焦点返回选中行，修改连接筛选后列表
  回到顶部，实时更新不会重置阅读位置。
- Appearance 提供 **Comfortable (12px)** 滚动条轨道与 8px 圆角滑块，或 **System default**，
  并可选择舒适/紧凑连接行。仅在内容溢出时显示滚动条，系统设置仍可能隐藏滚动条。
  抓包设置、外观与帮助使用标题固定的对话框，每个对话框仅有一个滚动正文区。
- 各视图的实时速率统一使用两秒移动平均，包含 Unattributed 流量。首次观察到的已有
  连接先建立基线，关闭的连接退出实时汇总。**Show raw peaks** 显示区间速率，
  **Log scale** 让小流量与大突发同时可见。快照无效时保留上一次有效视图，直到恢复。
- 图表为所有应用保留最近 60 秒内最多 121 个样本，切换应用不会中断采样。
  新抓包会话会清空图表。**Freeze view** 仅冻结显示，抓包和录制继续进行。
  窗口冻结或隐藏时只请求抓包状态。恢复显示时获取最新快照，不补建暂停期间的图表样本。
- **Show breakdown graph** 比较捕获与已归属速率。覆盖统计使用含链路层头部的原始
  帧长度，分为已归属、已追踪但未归属及追踪外字节。归属以处理数据包时为准，
  连接过期不会删除累计量。追踪外差额包含待处理、跳过及队列丢弃的数据包，队列清空
  时可能减少。未交付的数据包无法计量，VPN/全接口抓包可能重复计数。
  覆盖累计量与连接字节计数不同。
- 应用字节总量包含活跃及保留的已关闭连接，可能随历史过期而减少，并非完整会话
  累计量。**Hosts** 按活跃连接的不同远端 IP 计数，不区分端口。应用按进程名分组，
  已知的不同可执行文件路径保持独立；无法明确归属的缺失路径保留在路径不可用分组。
- 点击抓包状态旁的来源按钮打开设置。Linux 在未保存偏好且可用时默认选择
  **All interfaces (any)**。macOS 启用辅助程序后，**Automatic** 会尝试 PKTAP。
  已保存接口不可用时需选择替代接口。**Apply and restart capture** 正常停止旧会话后
  重新开始，录制需使用新文件。**Stop capture** 也在此处。
- **History** (`t`) 在本地切换保留的已关闭连接，隐藏时仍显示数量。实时合计仅包含
  活跃的已追踪连接，不含历史速率。引擎支持时，空闲连接会淡化并显示归档倒计时；
  选中及活跃行保持清晰。
- 开始前选择 **Record PCAPNG**，在保存对话框中指定未使用的文件名。录制使用引擎
  带注释的导出器，不能追溯之前的流量。停止抓包以完成写入；导出错误或记录丢失
  表示文件可能不完整。
- 外观、滚动条样式、行密度、首选视图和上次成功请求的接口保存在本地，UI 不持久化流量快照。
  沙箱状态和数据包计数位于侧栏 Capture Source 上方。
- 鼠标后退/前进及 Alt+左/右恢复视图和选择。Connections 中，`/` 聚焦搜索，`g`/`G`
  选择首行/末行，`Ctrl+f`/`Ctrl+b` 向下/向上移动一页。快捷键遵循筛选和排序，
  不拦截文本框或下拉菜单输入。上下方向键、Page Up/Page Down 和 Home/End 滚动当前内容。
  Escape 关闭检查器或当前设置对话框。
- 侧栏 **Help** 或 `h` 解释当前视图及快捷键。抓包设置和检查器也有各自的帮助。

## 本地流量历史（开发中）

开始抓包前，在抓包设置中启用 **Save traffic history**。初始默认关闭，应用重启后会记住您的选择，
与 PCAPNG 录制独立，修改在下次抓包时生效。桌面显示数据库路径、存储错误及跳过的
快照数。视图隐藏或冻结时仍会保存，停止抓包或退出应用后停止。

在侧栏打开 **Saved history**，即可在重启后浏览历史，按时间（含自定义本地日期）、
应用和抓包接口筛选，查看上传/下载总量、目的地及最近的匹配会话。发现项的
**Inspect traffic** 会选择对应应用、接口和时间范围。采样时间线可见时每 30 秒刷新，可用 **Auto-refresh** 暂停，
不受实时视图 Freeze 控制影响。刷新时保留当前图表、缩放、选择和图例状态，
新数据到达后再替换；失败时仍显示上次成功的结果。自动刷新等待两项历史查询完成后
再开始下一个 30 秒间隔，避免慢查询堆积。Connections 的 **History** 仍仅显示保留的已关闭连接。

首次读取后，时间线通过数据库变更游标读取新增或修正的十秒样本，并为每条连接
读取一个前置计数。最后一个十秒桶会重新读取，以完成部分区间。总量、应用/连接行
和显示桶由缓存窗口重新汇总，窗口移动时移除过期样本。异常基准仅推进新的有效区间；
修正时重放缓存基准，不重新读取全部旧样本。桌面仍向 UI 返回完整且有上限的显示报告。

筛选变更、向过去扩展、旧游标、元数据修正、保留期删除或数据库替换会触发完整读取。
缓存只保留一个视图，最多 500,000 条样本、500,000 条覆盖记录和最新 100,001 个有效
应用区间。更大窗口使用完整读取；缩短范围或更改筛选后重试缓存。变更索引保留最新
100,000 个修订。版本 1/2 数据库仍可只读浏览，抓包迁移到版本 3 后启用增量读取。
分钟汇总、会话详情和筛选选项仅在首次打开、点击 **Refresh history** 或更改筛选时更新，
不会随时间线的每次自动刷新重读。

历史应用行、历史连接行和实时 Connections 列表使用相同的共享原生图标。连接图标
显示在应用名称和 PID 旁；保留的已关闭连接不会使用旧 PID 查找图标。在任一视图显示时，图标会缓存到流量数据库
旁的 `application-icons.sqlite3`。每个不同 PNG 只保存一次，以 SHA-256 摘要标识，
可执行文件路径仅引用该条目，连接和十秒样本不会重复保存图片。缓存图标跨重启保留，
即使可执行文件已删除，也可显示直到被淘汰。最多保留 256 张 PNG（每张 128 KiB）和
2,048 条路径引用，清理无引用图片及最旧条目。实时查找可更新图标。历史查找不会使用
保存的 PID；没有稳定可执行文件路径的图标不会持久保存。不可用时仍显示占位图标。

历史仪表盘使用每条连接通常间隔十秒的采样。流量速率、观测连接数和抓包健康面板
共享光标和时间范围。悬停查看数值，拖动选择范围，用 **Zoom out** 返回。
图表获得焦点后，方向键查看区间，Enter 放大，Escape 清除光标。图例可切换曲线，
并显示最后记录值和最大值。异常标记打开证据，点击连接可查看累计计数及差值。
较长范围合并显示桶，放大后可查看十秒分辨率。速率是记录字节数除以完整显示区间，
属于区间平均值，并非瞬时速率。缺失值保留为空白。抓包健康用灰色表示无覆盖，
斜纹表示部分覆盖，圆点表示计数重置。连接每页 50 条，采样每页 200 条。差值归入结束时间戳，不插值；范围边界的
差值可能包含所选范围开始前的流量。

`flow_records` 保存连接元数据，进程或主机名补全时更新；`flow_samples` 保存时间戳、
累计计数和连续性分段。采样器仍接收每个快照，保留首次和最终观测，在连接消失或
抓包停止时写入剩余计数。只要短连接出现在引擎快照中，就会保留；不会重复采样已
保留的关闭连接。缺口、重新出现和计数重置会开始新分段，SQL 不应跨分段相减。
缺少的包计数保留为 NULL。`capture_intervals` 独立记录十秒桶的抓包覆盖情况。

开始历史采集时自动迁移到版本 3。旧分钟汇总保留在 **Minute summaries and earlier
history**，不会伪造旧数据的连接采样。时间线异常检测使用连接采样，旧分钟汇总不参与基准学习。连接
元数据显示最新身份，旧汇总保留采集时的归属。采样、覆盖记录和不活跃连接元数据
保留 30 天。每条持续观测的连接每天产生 8,640 个周期采样，另加首次、最终和边界
记录，存储量随活跃连接数量增长。

历史默认显示 **Applications**，采用与实时视图相同的紧凑应用行。选择应用可浏览
**Connections**，再选择连接查看计数详情。应用列表最多显示流量最大的 200 个应用，
其他应用可通过筛选器查找。流量、观测连接数和抓包质量图共用时间范围。连接数是
每个显示桶内不同的采样连接数，不是同时在线数。质量图显示缺口、不完整覆盖和
计数重置，不代表应用错误次数。

**Unusual activity** 从十秒连接采样中检测异常。点击时间线圆形标记查看依据，
**Inspect traffic** 定位对应应用、接口及精确的十秒区间。查看单个连接时，发现项
仍描述该应用所有连接的行为。每个可执行文件/接口需要过去七天内 180 个更早的完整
十秒区间（30 个活跃分钟），最多使用 720 个区间作为基准。不使用未知差值、无流量
起点、重置、超过 15 秒的区间、不完整覆盖、重叠会话或抓包错误。缺失观测不填零。
显示范围之前的采样可以训练基准，之后的采样不会参与较早的判断。

上传阈值取每十秒 2 MiB、此前中位数的五倍，以及中位数加六倍中位绝对偏差再加
256 KiB 中的最大值。下载最低阈值为 10 MiB、余量为 1 MiB；连接最低阈值为 20、
余量为 4。数值异常不参与基准更新。学习后的新目的地仅作为首次观测变化提示，
主机名补全或服务变更也可能导致它。每个发现项对应一个十秒区间，更大的显示桶
汇总其中的发现项数量。

发现项在浏览时重新计算，不永久归档，也不发送后台通知。分析最多使用所选范围及
此前七天训练窗口内最新的 100,000 个合格应用区间，只显示并标记最新 100 个发现项，
达到限制时显示提示。缩小时间范围或应用筛选可查看更早的发现项。连接每页 50 条，
采样每页 200 条，旧会话列表显示最近 20 个匹配项。

独立的 `rustnet-analytics` Rust crate 在非特权桌面后端消费现有引擎元数据。
后台写入器使用 SQLite 事务，队列最多容纳两个待处理快照。写入缓慢或失败不会阻塞
抓包管道：跳过的快照会被计数，错误只停止历史保存。停止抓包后会处理完队列中的写入。

数据库名为 `traffic-history.sqlite3`，位于 Tauri 本地应用数据目录（macOS 为
`~/Library/Application Support/io.github.domcyrus.rustnet.desktop/`）。其他平台请使用
界面显示的路径。存储内容包括应用名称及可执行文件路径、目的主机名或 IP、端口、
协议、字节增量、连接计数和观测覆盖率，不保存数据包内容或完整快照。删除历史时，
先停止抓包并退出应用，再删除数据库及可能存在的 `-wal` 和 `-shm` 文件。

普通 SQL 表包括 `sessions`、`applications`、`traffic_buckets`、`destinations` 和
`observation_buckets`。使用 `user_version` 管理版本，拒绝未知的新版本。
通过 `rusqlite` 捆绑 SQLite，无需单独安装数据库。分钟汇总和不活跃目的地保留
30 天，在打开历史及采集期间每小时清理。活跃目的地保留原始首次出现时间和计数。
删除后的空间可重复使用，文件不一定立即缩小。

旧分钟汇总的统计限制：

- 首个快照建立计数基准。初始字节、缺失快照、超过五秒的间隔或计数重置期间的增量
  不计入，以免产生虚假突增。保留的已关闭连接的最终增量会计入。所有快照都未包含的
  短连接无法统计。
- 字节归入观测到增量时所在的分钟，不推测间隔内的具体时间。覆盖时长按分钟边界拆分。
- 缺失分钟表示未知，不表示零。`observation_buckets.incomplete` 标记缺口、重置、
  丢包和归属降级。建立基线前检查 `observed_ms`、会话错误、`capture_error`、`dropped_snapshots` 和 `ended_ms`。
  正常结束的抓包应为 `runtime_status = 'stopped'`。
- 应用键优先使用可执行文件路径，其次是名称，无法归属的流量单独分组。仅名称的身份
  可信度较低。延迟获取的归属只影响后续增量，不重分配过去字节。主机名统一大小写并
  去除末尾点，缺失时使用 IP；后来获取主机名可能生成第二条目的地记录。
- 目的地 `connections` 统计每个会话内不同的流与目的地关联，包括启动时已存在的流。
  流量桶的连接计数仅包含连续观测间隔内新建并首次观测到的流。

使用 `sqlite3 -readonly /path/to/traffic-history.sqlite3` 打开界面显示的路径后，可执行：

```sql
SELECT f.id, f.remote_ip, f.remote_port, p.timestamp_ms, p.segment,
       p.bytes_sent, p.bytes_received, p.packets_sent, p.packets_received
FROM flow_samples AS p JOIN flow_records AS f ON f.id = p.flow_id
WHERE f.id = 1 ORDER BY p.timestamp_ms;

SELECT a.name, a.executable,
       SUM(t.bytes_sent) AS uploaded, SUM(t.bytes_received) AS downloaded
FROM traffic_buckets AS t JOIN applications AS a ON a.key = t.app_key
GROUP BY a.key ORDER BY uploaded DESC;

SELECT a.name, d.kind, d.value, d.connections,
       datetime(d.first_seen_ms / 1000, 'unixepoch') AS first_seen_utc,
       datetime(d.last_seen_ms / 1000, 'unixepoch') AS last_seen_utc
FROM destinations AS d JOIN applications AS a ON a.key = d.app_key
ORDER BY d.first_seen_ms DESC LIMIT 50;
```

无需构建 Tauri 即可测试采集器：
`cargo test --locked --manifest-path src-tauri/Cargo.toml -p rustnet-analytics`。

## 进程边界

桌面只通过结构化参数直接或经已批准的 macOS 辅助程序启动附带的 `rustnet-capture-engine`。`--list-interfaces` 返回 JSON，
不启动抓包。抓包使用 `--headless --output jsonl-delta --include-historic --stop-on-stdin-close`。
控制管道关闭时，包括桌面崩溃后，CLI 请求正常关闭并刷新输出。关闭窗口会等待引擎
停止；15 秒后仍未退出的子进程会被终止，录制结果标记为可能不完整。

macOS 辅助程序与应用通过相同 Team ID 和固定标识符的 Developer ID 签名要求验证 XPC 消息。
辅助程序只接受长度受限的接口名和已打开的录制/GeoIP 文件描述符，不接受可执行文件路径、
shell 命令或任意参数。降权身份来自经过认证的调用方，每个用户只允许一次捕获，
XPC 断开时会停止捕获。特权捕获将内置引擎复制到 root 私有目录，验证签名后执行该受保护副本，
不允许 debug 引擎覆盖。
录制文件由普通用户以独占方式创建，用户 GeoIP 自动发现由应用在传递描述符之前完成。

捆绑引擎使用 [RustNet #721](https://github.com/domcyrus/rustnet/pull/721) 的 `64fe320` 提供的 schema 2 增量输出和完整元数据，其中已包含合入的 #719。引擎在开始、定期检查点和结束时发送完整快照，其间发送变化连接的完整记录和删除列表。增量基线最多保留 10,000 条记录及 16 MiB 编码 JSON；超过后回退为完整快照。投影仍扫描选中的连接，因此输出减少并不代表 CPU 使用量不随历史增长。

Rust 桥接层在界面轮询或保存历史之前应用每条增量，检查序列连续性、ID 和重建后的数量，保留原始元数据并共享未变化的连接记录。更新缺失或无效时保留最后的有效视图并显示错误，直到后续完整快照恢复同步。每次新抓包都重置基线。历史保存接收完整快照，并保留序列缺口。

单条输入记录及重建后的快照分别限制为 128 MiB，增量模式最多支持 100,000 个连接。超过任一限制会明确报错并停止抓包，不会截断数据。诊断输出也有上限。桥接层仅在界面或历史写入器需要时构建完整的 schema 1 JSON；仍支持调试引擎的 schema 1 输入。

界面每 500 ms 携带游标轮询；未变化的响应不包含数据，也不更新图表。冻结或隐藏时只轮询状态和错误。桥接层持续重建，恢复显示时获取最新完整快照，包括新增、删除和延迟元数据。
界面验证 schema 1。Connections 使用连续表格；应用及其目标列表每页显示 75 项。
数据包解析、进程查询、
降权及沙箱仍由原有引擎负责。Webview 没有 shell 或通用文件系统插件权限。
防火墙和进程终止操作不在初版范围内。

## 验证与打包

```sh
pnpm run prepare:engine
pnpm run build
pnpm test
pnpm run test:engine-source
pnpm run test:macos-helper
pnpm run test:application-icons
pnpm run check:engine
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
pnpm audit
cargo audit --file src-tauri/Cargo.lock
pnpm run bundle
```

`pnpm run bundle` 构建 release CLI 和桌面程序，并将引擎包含在平台安装包中。
未配置生产签名、公证凭证及 Linux/Windows 的自动抓包权限配置。macOS 安装包还包含
辅助程序和 launch-daemon plist。构建可启用 PKTAP 的版本时，在 `pnpm run bundle` 前
将 `APPLE_SIGNING_IDENTITY` 设置为 Developer ID Application 身份，并提供 Tauri 公证凭证
（`APPLE_ID`、`APPLE_PASSWORD` 和 `APPLE_TEAM_ID`，或 Apple API 密钥凭证）。
具体步骤见 [Tauri 签名与公证指南](https://v2.tauri.app/distribute/sign/macos/)。
两个附带程序和应用须保留各自标识符，并使用相同 Team ID。
未签名或临时签名构建可以编译，但不能启用特权辅助程序。
`test:application-icons` 在 macOS、Linux 和 Windows 上检查原生图标。Linux 需要
`xvfb`、`xauth` 和 SVG 加载器（Debian/Ubuntu 上为 `librsvg2-common`）。
开发版本通过已安装的桌面条目和当前 GTK 主题获取 Linux 图标。通过 Flatpak、Snap
或 shell 包装脚本启动的应用，如果无法可靠匹配可执行文件，可能仍显示占位图标。
Windows 开发版本从可执行文件提取图标，必要时通过 PID 查找进程路径。
无法访问的进程或未嵌入图标的文件仍显示占位图标。

`test:macos-helper` 在 macOS 上运行普通用户的代理/描述符测试，在其他平台跳过，不安装守护程序。
签名集成验证还需批准辅助程序，选择 Automatic 并确认快照的归属方式为 PKTAP，
以及检查录制刷新、界面关闭和辅助程序移除。
若 DMG 打包停在 Finder 布局步骤，可使用 `CI=true pnpm run bundle` 跳过该外观设置。
修改引擎时，还需在 RustNet 仓库执行
[CONTRIBUTING.md](https://github.com/domcyrus/rustnet/blob/main/CONTRIBUTING.md) 中的检查。

当前 Tauri 的 Linux 依赖树会报告上游 RustSec 警告，包括停止维护的 crate 和
GLib `VariantStrIter` 的健全性问题（RUSTSEC-2024-0429）。桌面检查不屏蔽这些警告；
发布生产版本前请评估上游修复情况。

## 依赖更新

GitHub Dependabot 每天检查仓库根目录的 pnpm 依赖、`src-tauri` 中的 Cargo 依赖
和 GitHub Actions。配置沿用 RustNet 的策略：按生态分组，包括主版本升级。包更新
默认等待 3 天，主版本等待 7 天、次版本 4 天、补丁版本 3 天。GitHub Actions 更新
等待 3 天。Dependabot 自动将安全更新排除在等待期之外。合并前应审查 PR 和 CI
结果；未配置自动合并，无需安装外部应用。

`engine.lock.json` 和临时引擎补丁仍需一起手动维护，Dependabot 不会更新已应用
补丁的引擎提交版本。

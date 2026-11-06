# 隔離ビルド（未リリース）

[English](BUILDING.md) | [简体中文](BUILDING.zh-CN.md) | [日本語](BUILDING.ja.md)

ホストに Node.js、pnpm、Rust をインストールせずに Arch Linux 向けにビルドする場合は、下記の[コンテナビルド](#arch-linux-コンテナビルド)を使用してください。

macOS または Linux で、依存関係のスクリプト、ビルドツール、テストによるホストへのアクセスを制限します。通常のプラットフォーム依存関係、rustup で導入した Rust、Node.js、`package.json` で固定した pnpm を先にインストールしてください。これらのツールとリポジトリの起動スクリプトは信頼する入力です。Linux では Bubblewrap（Debian/Ubuntu では `sudo apt-get install bubblewrap`）と非特権ユーザー名前空間が必要です。macOS ではシステムの `sandbox-exec` が必要です。この手順は Windows に対応していません。

AppArmor がユーザー名前空間を制限する Ubuntu では、管理者が配布元の `bwrap-userns-restrict` プロファイルも有効にする必要があります（Ubuntu 24.04 では `apparmor-profiles` が提供）。[Ubuntu の名前空間ガイド](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007)を参照してください。起動スクリプトはシステムポリシーの変更や AppArmor の無効化を行わず、名前空間の初期化に失敗するとビルドを停止します。

リポジトリから実行します。事前の `pnpm install` は不要です。

```sh
node scripts/isolated-build.mjs
```

デスクトップのデバッグビルドでは `serde_json` 依存関係を最適化し、大きなスナップショットの検証コストを抑えます。デバッグアサーション、デバッグシンボル、デバッグ専用の sudo キャプチャ起動機能は引き続き有効です。

Git の追跡対象ファイルを `.isolated-build/runs/build-*/work` にコピーし、ローカル変更を保持します。シンボリックリンクと特殊ファイルは拒否します。新しいソースはビルド前に `git add` でステージしてください。未追跡ファイルはコピーしません。一般的な認証ファイル（`.npmrc`、`.netrc`、`.env*`、`credentials`、`credentials.toml`）は追跡対象でも除外します。他の秘密情報もビルド入力にコミットしないでください。専用の HOME、一時ディレクトリ、pnpm ストア、Cargo キャッシュ、ビルド出力を使います。元のチェックアウト、Git メタデータ、通常のキャッシュ、SSH agent、署名鍵、環境変数の認証情報はサンドボックスに公開しません。システムツールと選択した Rust ツールチェーンは読み取り専用です。作業コピーと専用キャッシュには書き込めます。

取得段階はネットワークを許可し、ライフサイクルスクリプトと pnpmfile フックを無効にして固定された pnpm 依存関係を取得します。固定したエンジンを取得してパッチのハッシュを検証し、`cargo fetch --locked` を実行します。プライベートリポジトリや認証が必要な registry は非対応です。取得時のネットワークは特定ホストの許可リストではありません。

ビルド段階は OS レベルでネットワークを遮断し、専用ストアからオフラインでインストールして、明示的に承認した依存関係のビルドスクリプトを実行します。エンジンとフロントエンドをビルドし、フロントエンドと Rust のテスト、書式確認、Clippy を実行して、フロントエンドを内蔵したデスクトップを生成します。Cargo もオフラインです。macOS は Seatbelt プロファイル、Linux は Bubblewrap のマウント、PID、ユーザー、ネットワーク名前空間を使い、capabilities を削除して新しい権限の取得を禁止します。設定失敗時に通常ビルドへ切り替えません。これはビルド用であり、実行中のデスクトップのサンドボックスではありません。

実行ファイルとキャプチャエンジンは `.isolated-build/target/debug/` に出力され、パスが表示されます。UI やキャプチャは開始しません。`--release` を付けると最適化ビルドを `.isolated-build/target/release/` に出力します。インストーラーや署名・公証済みバンドルは作りません。既存の `pnpm run bundle` は別の通常のパッケージ作成手順です。

段階を分けることもできます。

```sh
node scripts/isolated-build.mjs --fetch-only
node scripts/isolated-build.mjs --build-only
```

`--build-only` は前回取得時のソースコピーを使い、その後のチェックアウトの編集は反映しません。依存関係が不足するとオフラインで失敗します。通常の実行はソースをコピーし直し、専用キャッシュだけを再利用します。ビルドや起動したデスクトップが動いていないことを確認して `.isolated-build/` を削除すると、キャッシュを初期化できます。`.isolated-build.lock/` は同時ビルドと sudo セッションを防ぎます。強制終了後のロック削除は、前のセッションが終了したことを確認してから行ってください。

## Arch Linux コンテナビルド

Dockerfile は Arch Linux のパッケージを使い、最適化された x86_64 Linux 実行ファイルを生成します。ビルドホストに必要なのは Docker（現在の既定の BuildKit を使用）または Podman と、Bash および標準 Unix ツールです。ホストへの Node.js、pnpm、Rust、Bubblewrap のインストールは不要です。リポジトリで実行してください。

```sh
./scripts/build-container.sh
```

スクリプトはイメージをビルドし、そのビルド結果から停止状態のコンテナを作成して、両方のバイナリを `dist/linux/` にコピーし、一時コンテナを削除します。パスを指定すれば任意のディレクトリから呼び出せます。ビルドや取り出しに失敗した場合、既存のバイナリは保持されます。`dist/linux/rustnet-desktop` と `dist/linux/rustnet-capture-engine` は同じディレクトリに置いてください。最終イメージにはこの 2 ファイルだけが含まれ、取り出し専用であり `docker run` 用ではありません。スクリプトは実行ファイルを起動しません。`docker build --pull --output type=local,dest=dist/container .` で直接出力することもできます。ファイルは `dist/container/out/` に配置されます。

rootless Podman を使う場合は、sudo を付けずに `./scripts/build-container.sh --runtime podman` を実行してください。Docker も [rootless モード](https://docs.docker.com/engine/security/rootless/)に対応しています。既存の rootful Docker も使用できますが、デーモンはホストの root 権限を保持します。この手順はランタイムの設定やホストのポリシーを変更しません。

### コンテナの隔離

Docker/Podman がビルドサンドボックスを提供するため、Bubblewrap の入れ子や特権モードは不要です。システムパッケージと固定バージョンの pnpm はコンテナの root としてインストールします。プロジェクト依存関係の取得、コンパイル、テストは非特権の `builder` ユーザーで実行し、`no_new_privs` を有効にします。`.dockerignore` の許可リストはビルド入力だけを送り、Git メタデータ、ホストのキャッシュ、一般的な認証ファイルを除外します。許可したソースディレクトリを事前に確認してください。ソース内の秘密情報も入力に含まれます。ビルド手順にホストディレクトリ、Docker socket、SSH agent、秘密情報をマウントしません。

取得段階はネットワークを許可し、エンジンのパッチハッシュを検証して固定依存関係を取得します。pnpm のライフサイクルスクリプトと pnpmfile フックは無効です。コンパイルとテストは `RUN --network=none` を使い、pnpm と Cargo もオフラインで動作します。出力前に、ローカルの隔離ビルドと同じフロントエンドテスト、エンジンソーステスト、Rust テスト、書式確認、Clippy を通過する必要があります。失敗時は停止します。回避のために `--privileged`、ホストネットワーク、安全でないビルド権限を追加しないでください。

コンテナはホストのカーネルを共有し、隔離は生成物の信頼性を保証しません。Rootless Docker または Podman はランタイムの権限を減らします。より強い境界には使い捨て VM を使ってください。ベースイメージと Arch パッケージは継続的に更新されるため、ビット単位の再現性は保証しません。スクリプトは常に `--pull` でベースイメージを更新します。`./scripts/build-container.sh --no-cache` はパッケージのインストールと全ビルド手順も再実行します。pnpm 依存関係、Rust 依存関係、エンジンのリビジョンは引き続きリポジトリで固定されます。

### Arch Linux で実行

ホストと同じアーキテクチャ向けにビルドしてください。この手順は現在の Arch Linux x86_64 向けで、古いディストリビューションや ARM 向けではありません。ビルド環境のランタイムライブラリに合わせてホストを更新してください。

```sh
sudo pacman -Syu --needed webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg libpcap libelf
sudo setcap cap_net_raw+eip dist/linux/rustnet-capture-engine
./dist/linux/rustnet-desktop
```

上記の capability は eBPF を使わないキャプチャを許可します。信頼するビルドを取り出した後にのみ設定し、エンジンを置き換えたら再設定してください。UI は通常ユーザーで実行します。Node.js と pnpm は実行時に不要で、フロントエンドは内蔵されています。ビルド用サンドボックスは起動後のデスクトップを隔離しません。エンジンの追加要件は[キャプチャ権限](docs/GUIDE.ja.md#キャプチャ権限)を参照してください。ウィンドウが空白の場合は `WEBKIT_DISABLE_DMABUF_RENDERER=1 ./dist/linux/rustnet-desktop` を試してください。

## ビルド後の sudo キャプチャ

macOS の対話型端末で通常ユーザーとして実行します。

```sh
node scripts/desktop-sudo.mjs
```

既存の debug デスクトップとキャプチャエンジンを再利用し、依存関係の取得、コンパイル、テストを省略するには：

```sh
node scripts/desktop-sudo.mjs --no-build
```

sudo 認証の前に `.isolated-build/target/debug/` 内の両方の実行ファイルを確認します。ファイルがない、実行できない、またはシンボリックリンクの場合は再ビルドを案内して終了し、自動ビルドは行いません。デスクトップ終了まで同じビルドロックを保持します。現在のソースとの一致は確認しないため、ソースや依存関係を変更したら `--no-build` を省略してください。`pnpm run desktop:sudo --no-build` も使えます。

プロジェクトの依存関係をインストール済みなら、別名の `pnpm run desktop:sudo` も使えます。Node で直接実行すれば、事前の通常インストールが不要です。通常はまず隔離された debug ビルドとテストを完了し、成功した後でだけ sudo 認証を要求します。その後はリソースを内蔵したデスクトップを直接起動します。認証後に Vite、監視プロセス、コンパイラー、パッケージマネージャーのタスクは起動せず、sudo 認証の定期更新もしません。

**Automatic** を選んで開始します。sudo で起動するのはエンジンだけで、UI は通常ユーザーのままです。固定されたエンジンはキャプチャを開いてから権限を落とし、厳格なサンドボックスを適用します。明示的なインターフェース指定は PKTAP を無効にします。この手順はエンジンのソースやバイナリの上書き指定に対応しません。ヘルパー登録、署名、公証、sudoers の変更は不要です。リリースビルドは引き続き `RUSTNET_DEV_SUDO` を無視し、PKTAP には署名済みヘルパーが必要です。

sudo 認証が期限切れになっても進行中のキャプチャは続きますが、新しいキャプチャは失敗する場合があります。デスクトップを終了し、`--no-build` を付けて再実行すると、同じビルドを再利用して認証できます。停止または終了すると記録の書き込みを完了します。実際の PKTAP キャプチャと署名済み SMAppService デプロイは別途検証が必要です。

## 境界と確認

隔離は侵害されたビルドによるホストへの影響を抑えますが、生成物が信頼できることは保証しません。スクリプトは作業コピー、専用キャッシュ、生成物を変更できます。信頼できないソースや依存関係の生成物を実行したり、権限昇格させたりしないでください。エンジンには実行時サンドボックスより前の特権初期化が残ります。ビルド中は sudo 認証を要求も更新もせず、macOS では sudo/su の実行を拒否し、Linux では新しい権限を取得できません。

macOS の独自サンドボックスプロファイル API は非推奨です。機能がない場合や互換性がない場合は、隔離なしで実行せずエラーにします。OS の脆弱性や本当に信頼できないソースには、使い捨て VM がより強い境界を提供します。通常の `pnpm run desktop` のホットリロードはこの隔離の対象外です。

`node --test scripts/isolation.check.mjs` は実際のファイル・ネットワーク制限、子プロセスへの継承、ビルド後に認証する順序を確認します。CI では macOS と Linux で実行します。必要な OS サンドボックスの作成を外側のサンドボックスが妨げない環境で実行してください。

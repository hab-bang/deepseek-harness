# Agent Note: Linux 原生工具链预检

Status: implemented

[English](2026-08-15-linux-native-toolchain-preflight.md) | 中文

## 问题

[README.md](../../../../README.md) 记载的源码路径——`pnpm install`、`pnpm run build`、`pnpm dsh web`——在没有 C++ 工具链的 Linux 机器上无法运行。node-pty 只为 darwin 与 win32 发布预构建二进制，因此 [packages/subprocess/subprocess-local](../../../../packages/subprocess/subprocess-local/README.md) 声明的这个依赖会在安装期间由 node-gyp 编译。在没有 C++ 编译器的主机上，安装以 node-gyp 的 `make` 失败告终；而 pnpm 的依赖状态检查会在之后每次 `pnpm <script>` 之前重新执行同一个失败的安装，因此第二条与第三条命令报告的仍是编译器错误，而不是构建或提供服务。强行越过该失败的安装只会把报告推迟到启动阶段：插件树以 `Failed to load native module: pty.node` 失败，任何命令都无法工作。

读者所走的路径上没有任何地方写明这项要求：README.md 的源码路径没有，[docs/development.md](../../../../docs/development.md#prerequisites) 的前置条件也没有；而 node-gyp 自身的失败只提到 `cc1plus`，并未指出提供它的软件包。

## 决定

[scripts/check-native-toolchain.mjs](../../../../scripts/check-native-toolchain.mjs) 是工作区根目录的 `pnpm:devPreinstall` 脚本。在 Linux 上，它会在 pnpm 下载任何内容之前拒绝无法构建 node-pty 的安装，并列出缺失的工具以及 Debian/Ubuntu、Fedora/RHEL、Arch、Alpine 各一条安装命令。README.md 在其源码路径中写明该前置条件，docs/development.md 则将其纳入贡献者前置条件。

选用 `pnpm:devPreinstall` 是因为只有它运行得足够早。工作区安装不会运行任何项目的 `preinstall`——pnpm 先链接，再运行各项目的 `postinstall`，而那已在本检查所要抢先的依赖构建之后——而 `pnpm:devPreinstall` 在根项目中于解析之前运行，其非零退出即在此终止安装。`--prod` 或 `NODE_ENV=production` 的安装会跳过该 hook，直接报告 node-gyp 的失败。

三个条件使该检查不去干预与它无关的安装。它只作用于 Linux，因为 darwin 与 win32 安装已发布的二进制而无需编译。当已安装的 node-pty 已带有可加载的二进制时它直接通过，因此安装成功过的目录树在主机之后失去编译器时仍能工作；在那里拦截只会让一次无需构建的安装失败。它遵循 `CXX`、`MAKE`、`NODE_GYP_FORCE_PYTHON` 与 `PYTHON`，即 node-gyp 读取的同一批覆盖项，因此安装能接受的工具链，检查同样接受。`DSH_SKIP_NATIVE_TOOLCHAIN_CHECK=1` 是面向上述两条规则都识别不出其工具链的主机的既定退出开关。

该检查报告工具链缺失，并不免除对它的需要。在 Linux 上从源码编译 node-pty 仍然是 `pnpm install` 的行为。

## 备选方案

**仅靠文档。** 无论如何 README.md 与 docs/development.md 都会写明该前置条件，但漏看这句话的读者得到的仍是一段指向 `cc1plus` 的 node-gyp 栈追踪，而不是需要安装的软件包，并且这段输出会在三条命令中各重复一次。

**在 `spawnTerminal` 内改用动态 `import('node-pty')`。** 这能让插件树在没有二进制时也完成启动，并把失败限制在终端分配处。它对本问题毫无帮助——安装依然失败，`pnpm dsh web` 根本到不了启动阶段——而且它会悄悄放弃部署所要求的一项能力，违背仓库中错误配置必须在最早可解析处大声失败的规则。

**改为依赖发布 Linux 预构建二进制的分支，例如 `@lydell/node-pty`。** 这会在所有平台上彻底取消工具链要求。但它会替换掉 [patches/node-pty@1.1.0.patch](../../../../patches/node-pty@1.1.0.patch)、`allowBuilds` 条目与 spawn-helper postinstall 之下的 PTY 后端，且其当前发布版本跟随 1.2.0 beta；那是一项需要自身证据支撑的后端决策，而不是对一条未记载前置条件的修复。

**只警告而不失败。** pnpm 自身的失败会在数秒内接踵而至，并把警告淹没在 node-gyp 输出里，而这正是该检查要避免的结果。

## 测试

[scripts/check-native-toolchain.spec.ts](../../../../scripts/check-native-toolchain.spec.ts) 在一个持有合成 node-pty 使用方的临时仓库根目录上运行该脚本，因此结果取决于夹具的状态而非当前检出目录。它固定了缺失工具的报告与每一条发行版命令、`PATH` 上完整的工具链、两个方向上的 node-gyp 覆盖项、只报告缺失项的部分工具链、已构建的二进制，以及退出开关。在 node-pty 提供二进制的平台上，另有一个用例固定该脚本在没有编译器时通过。还有一个用例固定 `pnpm:devPreinstall` 的接线，防止它被改名为 pnpm 根本不会运行的 `preinstall`。

在未安装 `gcc-c++` 的 Fedora 44 上、从不含 `node_modules` 的目录树手工验证：`pnpm install`、`pnpm run build` 与 `pnpm dsh web` 都在任何下载或构建之前停在该检查处，并给出软件包清单。在工具链就位后，同一目录树可完成安装、构建，并在 `http://127.0.0.1:3080` 上提供 Web UI。

## 影响

`pnpm:devPreinstall` 会在每次开发态 `pnpm install` 时运行，包括 pnpm 依赖状态检查在 `pnpm <script>` 之前发起的那一次。其代价是若干次针对 `PATH` 的 `stat` 与 `access` 调用。

如果 Linux 主机上的编译器名称不是 `c++`、`g++` 或 `clang++`，且未由 `CXX` 指向，则需要 `DSH_SKIP_NATIVE_TOOLCHAIN_CHECK=1`。

二进制短路判断经由声明该依赖的包来解析 node-pty。若该依赖迁移到别的工作区包，需同时更新脚本中的 `NODE_PTY_CONSUMER`，否则检查将无法再识别已构建的目录树。

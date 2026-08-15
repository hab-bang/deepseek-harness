# Agent Note: Linux native-toolchain preflight

Status: implemented

English | [中文](2026-08-15-linux-native-toolchain-preflight.zh.md)

## Problem

The source path [README.md](../../../../README.md) documents — `pnpm install`, `pnpm run build`, `pnpm dsh web` — cannot run on a Linux machine without a C++ toolchain. node-pty publishes prebuilt bindings for darwin and win32 only, so the dependency [packages/subprocess/subprocess-local](../../../../packages/subprocess/subprocess-local/README.md) declares compiles with node-gyp during install. On a host without a C++ compiler the install ends in a node-gyp `make` failure, and pnpm's dependency-status check re-runs that same failing install ahead of every later `pnpm <script>`, so the second and third commands report the compiler error instead of building or serving. An install forced past the failure moves the report to boot, where the plugin tree fails with `Failed to load native module: pty.node` and no command works at all.

Nothing on the path a reader follows states the requirement: neither README.md's source path nor [docs/development.md](../../../../docs/development.md#prerequisites)'s prerequisites, and node-gyp's own failure names `cc1plus` rather than the package that supplies it.

## Decision

[scripts/check-native-toolchain.mjs](../../../../scripts/check-native-toolchain.mjs) is the workspace root's `pnpm:devPreinstall` script. On Linux it rejects an install that cannot build node-pty before pnpm downloads anything, naming the missing tools and one install command for each of Debian/Ubuntu, Fedora/RHEL, Arch, and Alpine. README.md states the prerequisite on its source path and docs/development.md carries it in the contributor prerequisites.

`pnpm:devPreinstall` is the hook because it is the only one that runs early enough. A workspace install runs no project's `preinstall` — pnpm links first and then runs each project's `postinstall`, which is after the dependency builds this check exists to precede — while `pnpm:devPreinstall` runs in the root project ahead of resolution, and its non-zero exit ends the install there. A `--prod` or `NODE_ENV=production` install skips the hook and reports node-gyp's failure directly.

Three conditions keep the check off installs it has no claim on. It applies to Linux alone, because darwin and win32 install the published binding without compiling. It passes when the installed node-pty already carries a loadable binding, so a tree that installed successfully keeps working on a host that later loses its compiler; blocking there would fail an install nothing needs to build. It honors `CXX`, `MAKE`, `NODE_GYP_FORCE_PYTHON`, and `PYTHON`, the same overrides node-gyp reads, so a toolchain the install would accept is a toolchain the check accepts. `DSH_SKIP_NATIVE_TOOLCHAIN_CHECK=1` is the documented opt-out for a host whose toolchain neither of those rules finds.

The check reports a missing toolchain; it does not remove the need for one. Compiling node-pty from source on Linux remains what `pnpm install` does.

## Alternatives considered

**Documentation alone.** README.md and docs/development.md carry the prerequisite either way, but a reader who misses the sentence still gets a node-gyp stack trace naming `cc1plus` rather than the packages to install, repeated for each of the three documented commands.

**A dynamic `import('node-pty')` inside `spawnTerminal`.** It would let the plugin tree boot without a binding and confine the failure to terminal allocation. It buys nothing for the reported problem — the install still fails, so `pnpm dsh web` never reaches boot — and it silently drops a capability the deployment asked for, against the repo's rule that misconfiguration fails loud at the earliest resolvable point.

**Depending on a fork that publishes Linux prebuilt bindings, such as `@lydell/node-pty`.** It would remove the toolchain requirement outright on every platform. It replaces the PTY backend under [patches/node-pty@1.1.0.patch](../../../../patches/node-pty@1.1.0.patch), the `allowBuilds` entry, and the spawn-helper postinstall, and its current publication tracks a 1.2.0 beta; that is a backend decision on its own evidence, not a fix for an undocumented prerequisite.

**Warning instead of failing.** pnpm's own failure follows within seconds and buries the warning in node-gyp output, which is the outcome the check exists to prevent.

## Testing

[scripts/check-native-toolchain.spec.ts](../../../../scripts/check-native-toolchain.spec.ts) runs the script against a temporary repository root holding a synthetic node-pty consumer, so the fixture's state decides the outcome rather than this checkout's. It pins the missing-tool report and every distribution command, a complete toolchain on `PATH`, the node-gyp overrides in both directions, a partial toolchain reporting only what is absent, the already-built binding, and the opt-out. On a platform node-pty ships a binding for, one case pins that the script passes without a compiler. One case pins the `pnpm:devPreinstall` wiring against a rename to `preinstall`, which pnpm would silently never run.

Verified by hand on Fedora 44 without `gcc-c++`, from a tree carrying no `node_modules`: `pnpm install`, `pnpm run build`, and `pnpm dsh web` each stop at the check with the package list, before any download or build. With the toolchain present the same tree installs, builds, and serves the Web UI on `http://127.0.0.1:3080`.

## Consequences

`pnpm:devPreinstall` runs on every development `pnpm install`, including the one pnpm's dependency-status check starts ahead of `pnpm <script>`. Its cost is a few `stat` and `access` calls over `PATH`.

A Linux host whose compiler is named something other than `c++`, `g++`, or `clang++` and is not pointed at by `CXX` needs `DSH_SKIP_NATIVE_TOOLCHAIN_CHECK=1`.

The binding short-circuit reads node-pty through the package that declares it. A move of that dependency to another workspace package updates `NODE_PTY_CONSUMER` in the script, or the check stops recognizing an already-built tree.

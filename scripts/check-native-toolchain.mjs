#!/usr/bin/env node
/**
 * Reject a Linux install that cannot build node-pty before pnpm downloads anything.
 *
 * node-pty publishes prebuilt bindings for darwin and win32 only, so on Linux
 * `pnpm install` compiles it with node-gyp and fails with a node-gyp stack when
 * the host has no C++ toolchain. Runs as the workspace root's
 * `pnpm:devPreinstall` script — pnpm runs no project's `preinstall` during a
 * workspace install, while this hook runs before resolution and a non-zero exit
 * aborts the install before any dependency build. `pnpm <script>` reaches the
 * same install through its dependency-status check, so the documented
 * `pnpm install` / `pnpm run build` / `pnpm dsh web` sequence reports the
 * missing packages instead of a compiler error.
 */
import { accessSync, constants, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKIP_VARIABLE = 'DSH_SKIP_NATIVE_TOOLCHAIN_CHECK'
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
// node-pty is a dependency of this package, not of the workspace root, so its
// binding resolves from the package that declares it.
const NODE_PTY_CONSUMER = 'packages/subprocess/subprocess-local/package.json'

// node-gyp reads each of these before falling back to a bare PATH name, so the
// check accepts exactly the toolchains an install would accept.
const REQUIREMENTS = [
  { label: 'a C++ compiler', names: ['c++', 'g++', 'clang++'], overrides: ['CXX'] },
  { label: 'make', names: ['make'], overrides: ['MAKE'] },
  { label: 'python3', names: ['python3', 'python'], overrides: ['NODE_GYP_FORCE_PYTHON', 'PYTHON'] },
]

const INSTALL_COMMANDS = [
  ['Debian/Ubuntu', 'sudo apt-get install -y g++ make python3'],
  ['Fedora/RHEL', 'sudo dnf install -y gcc-c++ make python3'],
  ['Arch', 'sudo pacman -S --needed gcc make python'],
  ['Alpine', 'sudo apk add --no-cache g++ make python3'],
]

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    // An absent candidate is simply not the file being looked for.
    return false
  }
}

function isExecutableFile(path) {
  if (!isFile(path)) return false
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    // A directory entry without the executable bit cannot be run as this tool.
    return false
  }
}

function resolvesToExecutable(name) {
  if (isAbsolute(name) || name.includes('/')) return isExecutableFile(resolve(root, name))
  const searchPath = process.env.PATH ?? ''
  return searchPath
    .split(delimiter)
    .filter(directory => directory !== '')
    .some(directory => isExecutableFile(join(directory, name)))
}

function satisfies(requirement) {
  for (const override of requirement.overrides) {
    const configured = process.env[override]
    if (configured !== undefined && configured !== '') return resolvesToExecutable(configured)
  }
  return requirement.names.some(resolvesToExecutable)
}

/**
 * Report whether the installed node-pty already carries a binding this platform can load.
 * The published bindings are not executable, so presence is what a loadable binding looks like.
 */
function nodePtyBindingExists() {
  let packageRoot
  try {
    packageRoot = dirname(createRequire(join(root, NODE_PTY_CONSUMER)).resolve('node-pty/package.json'))
  } catch {
    // node-pty is unresolvable before its first successful install, which is
    // exactly the case this check exists to guard.
    return false
  }
  const bindings = [
    join(packageRoot, 'build', 'Release', 'pty.node'),
    join(packageRoot, 'build', 'Debug', 'pty.node'),
    join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node'),
  ]
  return bindings.some(isFile)
}

function report(missing) {
  const lines = [
    `node-pty publishes no prebuilt binding for ${process.platform}-${process.arch}, so installing this repository compiles it from source.`,
    `Missing: ${missing.join(', ')}.`,
    '',
    ...INSTALL_COMMANDS.map(([distribution, command]) => `  ${distribution}: ${command}`),
    '',
    `Set ${SKIP_VARIABLE}=1 to install without this check.`,
  ]
  console.error(`[check-native-toolchain] ${lines.join('\n')}`)
}

function main() {
  if (process.env[SKIP_VARIABLE] === '1') return
  // darwin and win32 install the published prebuilt binding without compiling.
  if (process.platform !== 'linux') return
  if (nodePtyBindingExists()) return
  const missing = REQUIREMENTS.filter(requirement => !satisfies(requirement)).map(requirement => requirement.label)
  if (missing.length === 0) return
  report(missing)
  process.exitCode = 1
}

main()

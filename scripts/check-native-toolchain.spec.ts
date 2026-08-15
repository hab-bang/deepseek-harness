import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const checker = fileURLToPath(new URL('./check-native-toolchain.mjs', import.meta.url))
const roots: string[] = []
const onLinux = process.platform === 'linux'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// The checker derives the repository root from its own location, so a copy in a
// temporary `scripts/` directory reads that fixture's node-pty state instead of
// this checkout's installed one.
function fixture(options: { binding?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-toolchain-'))
  roots.push(root)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(checker, join(root, 'scripts/check-native-toolchain.mjs'))
  const consumer = join(root, 'packages/subprocess/subprocess-local')
  mkdirSync(consumer, { recursive: true })
  writeFileSync(join(consumer, 'package.json'), '{"name":"@deepseek-ai/dsh-subprocess-local"}\n')
  if (options.binding === true) {
    const packageRoot = join(consumer, 'node_modules/node-pty')
    mkdirSync(join(packageRoot, 'build/Release'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), '{"name":"node-pty","main":"./lib/index.js"}\n')
    // node-pty publishes its bindings without the executable bit.
    writeFileSync(join(packageRoot, 'build/Release/pty.node'), '', { mode: 0o644 })
  }
  return root
}

function toolchain(root: string, tools: string[]): string {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const tool of tools) writeFileSync(join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return bin
}

function check(root: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [join(root, 'scripts/check-native-toolchain.mjs')], {
    encoding: 'utf8',
    env: { PATH: '', ...env },
    timeout: 5_000,
  })
}

describe('native toolchain check wiring', () => {
  // A workspace install runs no project's `preinstall`, so that name would leave
  // the check silently unreachable ahead of the node-pty build it guards.
  it('runs from the one root hook pnpm executes before dependency builds', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { scripts: Record<string, string | undefined> }
    const scripts = manifest.scripts
    expect(scripts['pnpm:devPreinstall']).toBe('node scripts/check-native-toolchain.mjs')
    expect(scripts.preinstall).toBeUndefined()
  })
})

describe.skipIf(!onLinux)('native toolchain check on a source-compiling platform', () => {
  it('names every missing tool and one install command per distribution family', () => {
    const result = check(fixture())
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`node-pty publishes no prebuilt binding for linux-${process.arch}`)
    expect(result.stderr).toContain('Missing: a C++ compiler, make, python3.')
    expect(result.stderr).toContain('Debian/Ubuntu: sudo apt-get install -y g++ make python3')
    expect(result.stderr).toContain('Fedora/RHEL: sudo dnf install -y gcc-c++ make python3')
    expect(result.stderr).toContain('Arch: sudo pacman -S --needed gcc make python')
    expect(result.stderr).toContain('Alpine: sudo apk add --no-cache g++ make python3')
  })

  it('accepts a complete toolchain on PATH', () => {
    const root = fixture()
    const result = check(root, { PATH: toolchain(root, ['c++', 'make', 'python3']) })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('reads the same compiler and python overrides node-gyp reads', () => {
    const root = fixture()
    const bin = toolchain(root, ['clang++', 'make', 'python3.14'])
    const accepted = check(root, { CXX: join(bin, 'clang++'), MAKE: join(bin, 'make'), PYTHON: join(bin, 'python3.14') })
    expect(accepted.status, accepted.stderr).toBe(0)

    const rejected = check(root, { CXX: join(bin, 'absent-compiler'), MAKE: join(bin, 'make'), PYTHON: join(bin, 'python3.14') })
    expect(rejected.status).toBe(1)
    expect(rejected.stderr).toContain('Missing: a C++ compiler.')
  })

  it('reports only the tools that are absent', () => {
    const root = fixture()
    const result = check(root, { PATH: toolchain(root, ['g++']) })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Missing: make, python3.')
  })

  it('accepts an already-built binding so a toolchain-free runtime install still runs', () => {
    const result = check(fixture({ binding: true }))
    expect(result.status, result.stderr).toBe(0)
  })

  it('accepts the documented opt-out', () => {
    const result = check(fixture(), { DSH_SKIP_NATIVE_TOOLCHAIN_CHECK: '1' })
    expect(result.status, result.stderr).toBe(0)
  })
})

describe.skipIf(onLinux)('native toolchain check on a platform node-pty ships a prebuilt binding for', () => {
  it('installs without a compiler', () => {
    const result = check(fixture())
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
  })
})

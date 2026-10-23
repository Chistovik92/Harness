/**
 * DeepSeek Harness Desktop - package-target build script.
 *
 * Prepares the runtime, packages the application with electron-builder for the
 * selected target, and writes release artifacts plus a completion record.
 *
 * Usage:
 *   node scripts/package-target.ts win-x64          # signed Windows installer
 *   node scripts/package-target.ts win-x64 --unsigned   # unsigned test installer
 *   node scripts/package-target.ts win-x64 --dir        # directory build only
 *   node scripts/package-target.ts --check              # config + tooling preflight
 */

import electronBuilder from 'electron-builder'
import { createElectronBuilderConfig } from './electron-builder-config.mjs'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TARGET = process.argv[2]
const UNSIGNED = process.argv.includes('--unsigned')
const DIR_ONLY = process.argv.includes('--dir')
const CHECK_ONLY = process.argv.includes('--check')

const ROOT = process.cwd()
const BUILD_DIR = join(ROOT, '.desktop-build')
const TARGET_DIR = join(BUILD_DIR, 'targets', TARGET)

function log(msg) {
  const ts = new Date().toISOString()
  process.stdout.write(`[${ts}] [package:${TARGET}] ${msg}\n`)
}

async function preflight() {
  log('preflight: checking configuration and tooling')
  const cfg = createElectronBuilderConfig()
  log(`appId=${cfg.appId} productName=${cfg.productName} target=${TARGET} unsigned=${UNSIGNED} dir=${DIR_ONLY}`)

  if (!TARGET) {
    throw new Error('target required: win-x64 | mac-arm64 | mac-x64 | linux-x64 [--unsigned] [--dir] [--check]')
  }

  const valid = ['win-x64', 'mac-arm64', 'mac-x64', 'linux-x64']
  if (!valid.includes(TARGET)) {
    throw new Error(`unsupported target: ${TARGET} (expected one of ${valid.join(', ')})`)
  }

  if (!existsSync(join(ROOT, 'lib', 'main.js'))) {
    throw new Error('built main bundle missing at lib/main.js; run `pnpm run build` first')
  }

  log('preflight: ok')
  return cfg
}

async function packageTarget(cfg) {
  mkdirSync(TARGET_DIR, { recursive: true })

  const platform = TARGET.split('-')[0]
  const arch = TARGET.split('-')[1]

  const targets = []
  if (platform === 'win') targets.push({ target: 'nsis', arch })
  if (platform === 'mac') targets.push({ target: 'dmg', arch }, { target: 'zip', arch })
  if (platform === 'linux') targets.push({ target: 'AppImage', arch }, { target: 'deb', arch }, { target: 'rpm', arch })

  const options = {
    config: cfg,
    targets,
    publish: 'never',
    ...(DIR_ONLY ? { dir: true } : {}),
  }

  log(`building ${targets.map(t => `${t.target}/${t.arch}`).join(', ')} ...`)
  const build = await electronBuilder.build(options)
  log('build complete')

  const artifactDir = join(ROOT, 'release', TARGET)
  const record = {
    target: TARGET,
    version: cfg.extraMetadata.version,
    unsigned: UNSIGNED,
    dir: DIR_ONLY,
    timestamp: new Date().toISOString(),
    artifacts: build.artifactPaths || [],
  }

  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(join(artifactDir, 'packaging-record.json'), JSON.stringify(record, null, 2))
  log(`record written to ${join(artifactDir, 'packaging-record.json')}`)
}

async function main() {
  try {
    const cfg = await preflight()
    if (CHECK_ONLY) {
      log('check-only: configuration valid')
      return
    }
    await packageTarget(cfg)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}

main()

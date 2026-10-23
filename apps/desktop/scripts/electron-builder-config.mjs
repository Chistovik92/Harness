/**
 * DeepSeek Harness Desktop - electron-builder configuration factory.
 *
 * Produces platform-specific electron-builder configs for Windows (NSIS),
 * macOS (DMG + ZIP) and Linux (AppImage / deb / rpm).
 */

import { defineConfig } from 'electron-builder'

const APP_ID = process.env.DSH_DESKTOP_APP_ID || 'com.deepseek.harness'
const PRODUCT_NAME = 'DeepSeek Harness'
const VERSION = process.env.npm_package_version || '0.2.1-rc.3'
const IS_UNSIGNED = process.argv.includes('--unsigned')
const IS_DIR = process.argv.includes('--dir')
const TARGET = process.argv[2] || 'win-x64'

function isWin() { return TARGET.startsWith('win') }
function isMac() { return TARGET.startsWith('mac') }
function isLinux() { return TARGET.startsWith('linux') }

export function createElectronBuilderConfig() {
  const common = {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    directories: {
      app: '.',
      output: `release/${TARGET}`,
      buildResources: 'resources',
    },
    files: [
      'lib/**/*',
      'loading.html',
      'resources/**/*',
      '!resources/icon-*.svg',
    ],
    extraMetadata: {
      version: VERSION,
    },
    mac: isMac() ? {
      target: IS_DIR ? 'dir' : ['dmg', 'zip'],
      artifactName: `${PRODUCT_NAME}-${VERSION}-mac-${TARGET.replace('mac-','')}.${IS_DIR ? '' : 'ext'}`,
      entitlements: 'resources/entitlements.mac.plist',
      gatekeeperAssess: false,
      hardening: {
        entitlements: 'resources/entitlements.mac.plist',
        entitlementsInherit: 'resources/entitlements.mac.plist',
      },
    } : {},
    win: isWin() ? {
      target: IS_DIR ? 'dir' : 'nsis',
      artifactName: `${PRODUCT_NAME}-${VERSION}-win-${TARGET.replace('win-','')}-${IS_UNSIGNED ? 'unsigned' : 'signed'}.exe`,
      publisher: 'DeepSeek AI',
    } : {},
    linux: isLinux() ? {
      target: IS_DIR ? 'dir' : ['AppImage', 'deb', 'rpm'],
      artifactName: `${PRODUCT_NAME}-${VERSION}-linux-${TARGET.replace('linux-','')}.${IS_DIR ? '' : 'ext'}`,
      category: 'Development',
    } : {},
    nsis: isWin() ? {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: PRODUCT_NAME,
      license: 'installer/assets/LICENSE',
    } : {},
    dmg: isMac() ? {
      format: 'ULMO',
      icon: 'resources/icon-macos.icns',
      contents: [
        { x: 130, y: 220, type: 'link', path: '/Applications' },
        { x: 410, y: 220, type: 'file' },
      ],
    } : {},
  }

  if (IS_DIR) {
    return { ...common, directories: { output: `release/dir/${TARGET}` } }
  }

  return common
}

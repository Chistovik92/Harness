# DeepSeek Harness Desktop resources

Platform icon sources:
- `icon.svg` — master artwork (whale + gradients). Export each platform SVG as a transparent 1024×1024 PNG.
- `icon-windows.png` / `icon-windows.ico` — Windows app, installer and uninstaller icon.
- `icon-macos.png` / `icon-macos.icns` — macOS bundle icon (ICNS, up to 1024 px, rounded inset background).
- `icon-linux.png` — Linux icon.
- `tray-windows.ico` — Windows tray bitmap (16, 20, 24, 32, 40, 48, 64 px), rendered from `icon-windows.svg` via `pnpm run render:tray-icon`.

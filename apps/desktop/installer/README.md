/**
 * DeepSeek Harness Desktop - NSIS installer resources.
 * Sidebar bitmap placeholder (164x314 BMP would be generated here during build).
 * This file documents the assets required by installer.nsis.
 */

/*
Assets required for the Windows installer:
- resources/icon-windows.ico         -> application + installer + uninstaller icon
- resources/tray-windows.ico         -> Windows system tray icon
- installer/assets/sidebar.bmp       -> 164x314 welcome/finish sidebar (uninstaller shares it)
- installer/assets/LICENSE           -> license text shown on the license page

Generate the sidebar BMP from installer/assets/sidebar.png during `prepare`:
  sharp installer/assets/sidebar.png
    .resize(164, 314)
    .toFormat('bmp')
    .toFile('installer/assets/sidebar.bmp')
*/

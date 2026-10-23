/**
 * IPC channel constants (shared between main and renderer).
 */

export const CHANNELS = {
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  APP_GET_PATH: 'app:getPath',
  APP_GET_VERSION: 'app:getVersion',
  APP_IS_PACKAGED: 'app:isPackaged',
  DIALOG_OPEN_FILE: 'dialog:openFile',
  DIALOG_SAVE_FILE: 'dialog:saveFile',
  WINDOW_OPEN_SETTINGS: 'window:openSettings',
  WINDOW_QUIT: 'window:quit',
  UPDATE_AVAILABLE: 'update:available',
  UPDATE_DOWNLOADED: 'update:downloaded',
} as const

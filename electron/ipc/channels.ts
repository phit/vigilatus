/**
 * Canonical IPC channel names shared between the main process
 * (`ipcMain.handle` / `ipcMain.on` / `webContents.send`) and the preload bridge
 * (`ipcRenderer.invoke` / `ipcRenderer.on` / `ipcRenderer.send`).
 *
 * Channel string VALUES must stay stable — both ends match on the raw string.
 * Note: `i18next-electron-fs-backend` registers its own channels via
 * `mainBindings`/`preloadBindings`; those are intentionally not listed here.
 */
export const IPC = {
  cameras: {
    getAll: 'cameras:getAll',
    add: 'cameras:add',
    update: 'cameras:update',
    remove: 'cameras:remove',
    move: 'cameras:move',
    test: 'cameras:test',
    saveVolume: 'cameras:saveVolume',
  },
  stream: {
    start: 'stream:start',
    stop: 'stream:stop',
    /** Main -> renderer: a live stream process died. */
    died: 'stream:died',
  },
  streams: {
    /** Main -> renderer: all streams were invalidated (e.g. resume from sleep). */
    invalidated: 'streams:invalidated',
  },
  snapshot: {
    get: 'snapshot:get',
  },
  recordings: {
    list: 'recordings:list',
    events: 'recordings:events',
    play: 'recordings:play',
  },
  diagnostics: {
    getRuntimeInfo: 'diagnostics:getRuntimeInfo',
  },
  layout: {
    get: 'layout:get',
    save: 'layout:save',
  },
  ui: {
    showCameraContextMenu: 'ui:showCameraContextMenu',
    showTileContextMenu: 'ui:showTileContextMenu',
    showLayoutContextMenu: 'ui:showLayoutContextMenu',
    openAddCamera: 'ui:openAddCamera',
    setPreviewsVisible: 'ui:setPreviewsVisible',
    setTimelineVisible: 'ui:setTimelineVisible',
    setHeaderVisible: 'ui:setHeaderVisible',
    setDebugOverlayVisible: 'ui:setDebugOverlayVisible',
    setPreviewPosition: 'ui:setPreviewPosition',
    setLanguage: 'ui:setLanguage',
  },
} as const;

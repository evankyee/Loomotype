const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to renderer
contextBridge.exposeInMainWorld('soron', {
  // Screen capture
  getSources: () => ipcRenderer.invoke('get-sources'),

  // File operations
  saveRecording: (buffer, filename) =>
    ipcRenderer.invoke('save-recording', { buffer, filename }),
  saveMetadata: (filename, metadata) =>
    ipcRenderer.invoke('save-metadata', { filename, metadata }),
  getRecordings: () => ipcRenderer.invoke('get-recordings'),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  showSaveDialog: () => ipcRenderer.invoke('show-save-dialog'),

  // Screen info for metadata
  getScreenDimensions: () => ipcRenderer.invoke('get-screen-dimensions'),
  getCursorPosition: () => ipcRenderer.invoke('get-cursor-position'),

  // Click tracking for auto-zoom
  startClickTracking: () => ipcRenderer.invoke('start-click-tracking'),
  stopClickTracking: () => ipcRenderer.invoke('stop-click-tracking'),
  addClickEvent: () => ipcRenderer.invoke('add-click-event'),

  // Recording state
  recordingStarted: (sourceId, includeCamera) => ipcRenderer.invoke('recording-started', sourceId, includeCamera),
  recordingStopped: () => ipcRenderer.invoke('recording-stopped'),
  hideMainWindow: () => ipcRenderer.invoke('hide-main-window'),
  showRecordingHighlight: (sourceId) => ipcRenderer.invoke('show-recording-highlight', sourceId),
  hideRecordingHighlight: () => ipcRenderer.invoke('hide-recording-highlight'),

  // Control window actions
  stopRecording: () => ipcRenderer.invoke('stop-recording-from-control'),
  cancelRecording: () => ipcRenderer.invoke('cancel-recording-from-control'),
  togglePauseFromControl: () => ipcRenderer.invoke('toggle-pause-from-control'),
  switchLayout: (layout) => ipcRenderer.invoke('switch-layout', layout),

  // Settings
  getStore: (key) => ipcRenderer.invoke('get-store', key),
  setStore: (key, value) => ipcRenderer.invoke('set-store', key, value),

  // Personalization - supports two modes:
  // 1. cameraFilePath set: separate camera file for lip-sync
  // 2. hasEmbeddedBubble=true: camera bubble is IN the screen recording
  uploadForPersonalization: (filePath, cameraFilePath, hasEmbeddedBubble = false) =>
    ipcRenderer.invoke('upload-for-personalization', { filePath, cameraFilePath, hasEmbeddedBubble }),

  // Upload to backend and get video ID for web editor
  uploadToBackend: (filePath, fileName) =>
    ipcRenderer.invoke('upload-to-backend', { filePath, fileName }),

  // Open external URL (web editor)
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Window management
  toggleRecents: () => ipcRenderer.invoke('toggle-recents'),
  closeRecents: () => ipcRenderer.invoke('close-recents'),
  toggleSettings: () => ipcRenderer.invoke('toggle-settings'),
  closeSettings: () => ipcRenderer.invoke('close-settings'),
  toggleTeleprompter: () => ipcRenderer.invoke('toggle-teleprompter'),
  closeTeleprompter: () => ipcRenderer.invoke('close-teleprompter'),
  toggleBlurOverlay: () => ipcRenderer.invoke('toggle-blur-overlay'),
  closeBlurOverlay: () => ipcRenderer.invoke('close-blur-overlay'),
  addBlurRegions: (regions) => ipcRenderer.invoke('add-blur-regions', regions),

  // Listen for window closed events
  onRecentsClosed: (callback) => {
    ipcRenderer.on('recents-closed', callback);
    return () => ipcRenderer.removeListener('recents-closed', callback);
  },
  onSettingsClosed: (callback) => {
    ipcRenderer.on('settings-closed', callback);
    return () => ipcRenderer.removeListener('settings-closed', callback);
  },
  onTeleprompterClosed: (callback) => {
    ipcRenderer.on('teleprompter-closed', callback);
    return () => ipcRenderer.removeListener('teleprompter-closed', callback);
  },
  onBlurOverlayClosed: (callback) => {
    ipcRenderer.on('blur-overlay-closed', callback);
    return () => ipcRenderer.removeListener('blur-overlay-closed', callback);
  },
  onBlurRegionsAdded: (callback) => {
    ipcRenderer.on('blur-regions-added', (event, regions) => callback(regions));
    return () => ipcRenderer.removeListener('blur-regions-added', callback);
  },

  // Event listeners
  onStopRecording: (callback) => {
    ipcRenderer.on('stop-recording', callback);
    return () => ipcRenderer.removeListener('stop-recording', callback);
  },
  onCancelRecording: (callback) => {
    ipcRenderer.on('cancel-recording', callback);
    return () => ipcRenderer.removeListener('cancel-recording', callback);
  },
  onTogglePause: (callback) => {
    ipcRenderer.on('toggle-pause', callback);
    return () => ipcRenderer.removeListener('toggle-pause', callback);
  },
  onOpenSettings: (callback) => {
    ipcRenderer.on('open-settings', callback);
    return () => ipcRenderer.removeListener('open-settings', callback);
  },
  onLayoutChange: (callback) => {
    ipcRenderer.on('layout-change', (event, layout) => callback(layout));
    return () => ipcRenderer.removeListener('layout-change', callback);
  },
});

// Also expose some native APIs safely
contextBridge.exposeInMainWorld('platform', {
  isMac: process.platform === 'darwin',
  isWindows: process.platform === 'win32',
  isLinux: process.platform === 'linux',
});

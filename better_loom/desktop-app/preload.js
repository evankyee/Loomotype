const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to renderer
contextBridge.exposeInMainWorld('soron', {
  // Screen capture
  getSources: () => ipcRenderer.invoke('get-sources'),

  // File operations
  saveRecording: (buffer, filename) =>
    ipcRenderer.invoke('save-recording', { buffer, filename }),
  getRecordings: () => ipcRenderer.invoke('get-recordings'),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  showSaveDialog: () => ipcRenderer.invoke('show-save-dialog'),

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
});

// Also expose some native APIs safely
contextBridge.exposeInMainWorld('platform', {
  isMac: process.platform === 'darwin',
  isWindows: process.platform === 'win32',
  isLinux: process.platform === 'linux',
});

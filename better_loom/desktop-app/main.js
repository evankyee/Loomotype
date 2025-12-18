const { app, BrowserWindow, ipcMain, desktopCapturer, systemPreferences, dialog, Menu, Tray, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const Store = require('electron-store');

const store = new Store();

let mainWindow = null;
let recordingWindow = null;
let tray = null;
let isRecording = false;

// API endpoint (will be configurable) - use 127.0.0.1 to avoid IPv6 issues
const API_URL = store.get('apiUrl', 'http://127.0.0.1:8000');

function createMainWindow() {
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;

  // Floating bar dimensions (extra height for tooltips)
  const barWidth = 440;
  const barHeight = 90; // Extra space above for tooltips

  mainWindow = new BrowserWindow({
    width: barWidth,
    height: barHeight,
    x: Math.floor(screenWidth / 2 - barWidth / 2),
    y: screenHeight - barHeight - 30,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
    show: false,
  });

  mainWindow.loadFile('renderer/index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Recents popup window
let recentsWindow = null;

function createRecentsWindow() {
  if (recentsWindow) {
    recentsWindow.focus();
    return;
  }

  // PERF: Use pre-warmed window if available (instant show)
  if (prewarmedRecents && !prewarmedRecents.isDestroyed()) {
    recentsWindow = prewarmedRecents;
    prewarmedRecents = null; // Consume it
    recentsWindow.show();
    recentsWindow.focus();

    // Set up close handler
    recentsWindow.on('blur', () => {
      if (recentsWindow && !recentsWindow.isDestroyed()) {
        recentsWindow.hide();
        if (mainWindow) mainWindow.webContents.send('recents-closed');
        recentsWindow = null;
        // Re-warm for next use
        setTimeout(() => prewarmWindows(), 100);
      }
    });

    recentsWindow.on('closed', () => {
      recentsWindow = null;
    });
    return;
  }

  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;

  const recentsWidth = 340;
  const recentsHeight = 360;

  recentsWindow = new BrowserWindow({
    width: recentsWidth,
    height: recentsHeight,
    x: Math.floor(screenWidth / 2 - recentsWidth / 2),
    y: screenHeight - recentsHeight - 100,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  recentsWindow.loadFile('renderer/recents.html');

  recentsWindow.once('ready-to-show', () => {
    recentsWindow.show();
  });

  recentsWindow.on('closed', () => {
    recentsWindow = null;
    // Tell main window recents is closed
    if (mainWindow) {
      mainWindow.webContents.send('recents-closed');
    }
  });

  // Close when clicking outside
  recentsWindow.on('blur', () => {
    if (recentsWindow && !recentsWindow.isDestroyed()) {
      recentsWindow.close();
    }
  });
}

function closeRecentsWindow() {
  if (recentsWindow && !recentsWindow.isDestroyed()) {
    recentsWindow.close();
    recentsWindow = null;
  }
}

// Settings popup window
let settingsWindow = null;

// Teleprompter window
let teleprompterWindow = null;

// Blur overlay window
let blurOverlayWindow = null;

function createTeleprompterWindow() {
  if (teleprompterWindow) {
    teleprompterWindow.focus();
    return;
  }

  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;

  const prompterWidth = 600;
  const prompterHeight = 200;

  teleprompterWindow = new BrowserWindow({
    width: prompterWidth,
    height: prompterHeight,
    x: Math.floor(screenWidth / 2 - prompterWidth / 2),
    y: 50, // Top of screen
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: true,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  // CRITICAL: Exclude from screen capture on macOS
  teleprompterWindow.setContentProtection(true);

  teleprompterWindow.loadFile('renderer/teleprompter.html');

  teleprompterWindow.once('ready-to-show', () => {
    teleprompterWindow.show();
  });

  teleprompterWindow.on('closed', () => {
    teleprompterWindow = null;
    // Notify main window
    if (mainWindow) {
      mainWindow.webContents.send('teleprompter-closed');
    }
  });
}

function closeTeleprompterWindow() {
  if (teleprompterWindow && !teleprompterWindow.isDestroyed()) {
    teleprompterWindow.close();
    teleprompterWindow = null;
  }
}

function createBlurOverlayWindow() {
  if (blurOverlayWindow) {
    blurOverlayWindow.focus();
    return;
  }

  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();

  // Full screen overlay for drawing blur regions
  blurOverlayWindow = new BrowserWindow({
    width: display.size.width,
    height: display.size.height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  // CRITICAL: Exclude from screen capture (blur regions shouldn't appear in recording)
  blurOverlayWindow.setContentProtection(true);

  blurOverlayWindow.loadFile('renderer/blur-overlay.html');

  blurOverlayWindow.once('ready-to-show', () => {
    blurOverlayWindow.show();
  });

  blurOverlayWindow.on('closed', () => {
    blurOverlayWindow = null;
    // Notify main window
    if (mainWindow) {
      mainWindow.webContents.send('blur-overlay-closed');
    }
  });
}

function closeBlurOverlayWindow() {
  if (blurOverlayWindow && !blurOverlayWindow.isDestroyed()) {
    blurOverlayWindow.close();
    blurOverlayWindow = null;
  }
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  // PERF: Use pre-warmed window if available (instant show)
  if (prewarmedSettings && !prewarmedSettings.isDestroyed()) {
    settingsWindow = prewarmedSettings;
    prewarmedSettings = null; // Consume it
    settingsWindow.show();
    settingsWindow.focus();

    // Set up close handler
    settingsWindow.on('blur', () => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.hide();
        if (mainWindow) mainWindow.webContents.send('settings-closed');
        settingsWindow = null;
        // Re-warm for next use
        setTimeout(() => prewarmWindows(), 100);
      }
    });

    settingsWindow.on('closed', () => {
      settingsWindow = null;
    });
    return;
  }

  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;

  const settingsWidth = 300;
  const settingsHeight = 320;

  settingsWindow = new BrowserWindow({
    width: settingsWidth,
    height: settingsHeight,
    x: Math.floor(screenWidth / 2 - settingsWidth / 2),
    y: screenHeight - settingsHeight - 120,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  settingsWindow.loadFile('renderer/settings.html');

  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
    if (mainWindow) {
      mainWindow.webContents.send('settings-closed');
    }
  });

  settingsWindow.on('blur', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close();
    }
  });
}

function closeSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
    settingsWindow = null;
  }
}

function createRecordingWindow(sourceId = null) {
  // Loom-style floating recording control window
  recordingWindow = new BrowserWindow({
    width: 280,
    height: 160,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  recordingWindow.loadFile('renderer/recording-controls.html');

  // Position in bottom-center of screen
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  recordingWindow.setPosition(Math.floor(width / 2 - 140), height - 180);

  // Make window draggable but pass through clicks on transparent areas
  recordingWindow.setIgnoreMouseEvents(false);

  recordingWindow.on('closed', () => {
    recordingWindow = null;
    hideRecordingHighlight();
  });

  // If recording a specific source, show highlight
  if (sourceId) {
    showRecordingHighlight(sourceId);
  }
}

// Highlight window to show recording area
let highlightWindow = null;

function showRecordingHighlight(sourceId) {
  if (highlightWindow) {
    highlightWindow.close();
  }

  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  // Create a borderless transparent window that covers the screen
  highlightWindow = new BrowserWindow({
    x: 0,
    y: 0,
    width: display.size.width,
    height: display.size.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Pass through all mouse events
  highlightWindow.setIgnoreMouseEvents(true);

  // Load simple HTML with red border
  highlightWindow.loadURL(`data:text/html,
    <html>
      <body style="margin:0;padding:0;background:transparent;">
        <div style="
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          border: 3px solid #ef4444;
          border-radius: 8px;
          pointer-events: none;
          box-sizing: border-box;
        ">
          <div style="
            position: absolute;
            top: 8px;
            left: 50%;
            transform: translateX(-50%);
            background: #ef4444;
            color: white;
            padding: 4px 12px;
            border-radius: 4px;
            font-family: -apple-system, sans-serif;
            font-size: 12px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 6px;
          ">
            <span style="width:8px;height:8px;background:white;border-radius:50%;animation:pulse 1.5s infinite;"></span>
            Recording
          </div>
        </div>
        <style>
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
          }
        </style>
      </body>
    </html>
  `);
}

function hideRecordingHighlight() {
  if (highlightWindow) {
    highlightWindow.close();
    highlightWindow = null;
  }
}

// Recording control window (Loom-style floating controls)
let recordingControlWindow = null;

function createRecordingControlWindow() {
  if (recordingControlWindow) {
    recordingControlWindow.show();
    return;
  }

  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  recordingControlWindow = new BrowserWindow({
    width: 300,
    height: 70,
    x: Math.floor(width / 2 - 150),
    y: height - 100,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Load the recording control UI
  recordingControlWindow.loadFile('renderer/recording-control.html');

  recordingControlWindow.on('closed', () => {
    recordingControlWindow = null;
  });
}

function closeRecordingControlWindow() {
  if (recordingControlWindow) {
    recordingControlWindow.close();
    recordingControlWindow = null;
  }
}

// Camera bubble window (Loom-style floating camera preview)
let cameraBubbleWindow = null;

function createCameraBubbleWindow() {
  console.log('[MAIN] createCameraBubbleWindow called');

  if (cameraBubbleWindow) {
    console.log('[MAIN] Camera bubble already exists, showing it');
    cameraBubbleWindow.show();
    return;
  }

  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  // Larger bubble (400px) for better face detection during lip-sync
  const bubbleSize = 400;
  const padding = 30;
  console.log(`[MAIN] Creating camera bubble at position (${padding}, ${height - bubbleSize - padding}), size ${bubbleSize}x${bubbleSize}`);

  // Position in bottom-left corner - this will be captured in screen recording
  cameraBubbleWindow = new BrowserWindow({
    width: bubbleSize,
    height: bubbleSize,
    x: padding,
    y: height - bubbleSize - padding,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    hasShadow: false, // We handle shadow in CSS
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Load the camera bubble UI
  cameraBubbleWindow.loadFile('renderer/camera-bubble.html');

  cameraBubbleWindow.on('closed', () => {
    cameraBubbleWindow = null;
  });
}

function closeCameraBubbleWindow() {
  if (cameraBubbleWindow) {
    cameraBubbleWindow.close();
    cameraBubbleWindow = null;
  }
}

function createTray() {
  // Create system tray icon
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');

  // If no icon exists, skip tray
  if (!fs.existsSync(iconPath)) {
    return;
  }

  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'New Recording', click: () => startNewRecording() },
    { label: 'My Videos', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Settings', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setToolTip('Soron Recorder');
  tray.setContextMenu(contextMenu);
}

function setupGlobalShortcuts() {
  // Cmd+Shift+R to start/stop recording
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    if (isRecording) {
      stopRecording();
    } else {
      startNewRecording();
    }
  });

  // Cmd+Shift+P to pause/resume
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    if (isRecording) {
      togglePause();
    }
  });

  // Cmd+Shift+T to toggle teleprompter
  globalShortcut.register('CommandOrControl+Shift+T', () => {
    if (teleprompterWindow && !teleprompterWindow.isDestroyed()) {
      closeTeleprompterWindow();
    } else {
      createTeleprompterWindow();
    }
  });

  // Cmd+Shift+B to open blur region selector
  globalShortcut.register('CommandOrControl+Shift+B', () => {
    if (isRecording) {
      createBlurOverlayWindow();
    }
  });
}

async function checkPermissions() {
  if (process.platform === 'darwin') {
    // Check screen recording permission
    const screenAccess = systemPreferences.getMediaAccessStatus('screen');
    if (screenAccess !== 'granted') {
      // This will prompt the user
      await desktopCapturer.getSources({ types: ['screen'] });
    }

    // Check microphone permission
    const micAccess = systemPreferences.getMediaAccessStatus('microphone');
    if (micAccess !== 'granted') {
      await systemPreferences.askForMediaAccess('microphone');
    }

    // Check camera permission
    const cameraAccess = systemPreferences.getMediaAccessStatus('camera');
    if (cameraAccess !== 'granted') {
      await systemPreferences.askForMediaAccess('camera');
    }
  }
}

function startNewRecording(sourceId = null) {
  if (!recordingWindow) {
    createRecordingWindow(sourceId);
  }
  recordingWindow?.show();
  mainWindow?.hide();
}

function stopRecording() {
  isRecording = false;
  recordingWindow?.webContents.send('stop-recording');
}

function togglePause() {
  recordingWindow?.webContents.send('toggle-pause');
}

function openSettings() {
  mainWindow?.webContents.send('open-settings');
  mainWindow?.show();
}

// IPC Handlers
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  });

  return sources.map(source => ({
    id: source.id,
    name: source.name,
    thumbnail: source.thumbnail.toDataURL(),
    appIcon: source.appIcon?.toDataURL(),
  }));
});

ipcMain.handle('save-recording', async (event, { buffer, filename }) => {
  const videosDir = path.join(app.getPath('videos'), 'Soron');

  if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir, { recursive: true });
  }

  const filePath = path.join(videosDir, filename);
  fs.writeFileSync(filePath, Buffer.from(buffer));

  return filePath;
});

// Save metadata sidecar file alongside video
ipcMain.handle('save-metadata', async (event, { filename, metadata }) => {
  const videosDir = path.join(app.getPath('videos'), 'Soron');
  const metadataFilename = filename.replace(/\.(webm|mp4)$/, '.metadata.json');
  const metadataPath = path.join(videosDir, metadataFilename);

  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  return metadataPath;
});

// Show file in Finder/Explorer (local-first feature)
ipcMain.handle('show-in-folder', async (event, filePath) => {
  const { shell } = require('electron');
  shell.showItemInFolder(filePath);
});

// Get screen dimensions for metadata normalization
ipcMain.handle('get-screen-dimensions', async () => {
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  return {
    width: display.size.width,
    height: display.size.height
  };
});

// Get cursor position for cursor tracking feature
ipcMain.handle('get-cursor-position', async () => {
  const { screen } = require('electron');
  return screen.getCursorScreenPoint();
});

// Global click tracking for auto-zoom (works even when app not focused)
let clickTrackingEnabled = false;
let trackedClicks = [];
let recordingStartTimestamp = null;

ipcMain.handle('start-click-tracking', async () => {
  clickTrackingEnabled = true;
  trackedClicks = [];
  recordingStartTimestamp = Date.now();

  // Use Electron's globalShortcut to detect mouse buttons isn't possible,
  // so we'll use a polling approach with screen.getCursorScreenPoint()
  // combined with the native module approach below
  return { started: true };
});

ipcMain.handle('stop-click-tracking', async () => {
  clickTrackingEnabled = false;
  const clicks = [...trackedClicks];
  trackedClicks = [];
  recordingStartTimestamp = null;
  return clicks;
});

ipcMain.handle('add-click-event', async (event, clickData) => {
  // Called from recording control window when user manually marks a click
  if (clickTrackingEnabled && recordingStartTimestamp) {
    const { screen } = require('electron');
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getPrimaryDisplay();

    trackedClicks.push({
      t: (Date.now() - recordingStartTimestamp) / 1000,
      x: cursor.x / display.size.width,
      y: cursor.y / display.size.height,
      button: 'left'
    });
  }
});

ipcMain.handle('get-recordings', async () => {
  const videosDir = path.join(app.getPath('videos'), 'Soron');

  if (!fs.existsSync(videosDir)) {
    return [];
  }

  const files = fs.readdirSync(videosDir)
    .filter(f => f.endsWith('.webm') || f.endsWith('.mp4'))
    .map(f => {
      const filePath = path.join(videosDir, f);
      const stats = fs.statSync(filePath);
      return {
        name: f,
        path: filePath,
        size: stats.size,
        created: stats.birthtime,
      };
    })
    .sort((a, b) => b.created - a.created);

  return files;
});

ipcMain.handle('open-file', async (event, filePath) => {
  const { shell } = require('electron');
  shell.openPath(filePath);
});

ipcMain.handle('open-external', async (event, url) => {
  const { shell } = require('electron');
  shell.openExternal(url);
});

ipcMain.handle('show-save-dialog', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `soron-recording-${Date.now()}.webm`,
    filters: [
      { name: 'WebM Video', extensions: ['webm'] },
      { name: 'MP4 Video', extensions: ['mp4'] },
    ],
  });
  return result;
});

ipcMain.handle('recording-started', (event, sourceId, includeCamera = false) => {
  console.log(`[MAIN] recording-started IPC: sourceId=${sourceId}, includeCamera=${includeCamera}`);
  isRecording = true;

  // Hide main window
  mainWindow?.hide();

  // Show recording highlight if recording screen
  if (sourceId) {
    showRecordingHighlight(sourceId);
  }

  // Create and show recording control window
  createRecordingControlWindow();

  // SIMPLIFIED APPROACH: Camera bubble window IS captured in screen recording
  // This gives us a single video with camera already composited = no sync issues
  // The bubble is 300px for better face detection during lip-sync
  if (includeCamera) {
    console.log('[MAIN] Creating camera bubble window (will be captured in screen recording)');
    createCameraBubbleWindow();
  }
});

ipcMain.handle('recording-stopped', () => {
  isRecording = false;
  hideRecordingHighlight();
  closeRecordingControlWindow();
  closeCameraBubbleWindow();
  recordingWindow?.close();
  mainWindow?.show();
});

ipcMain.handle('hide-main-window', () => {
  mainWindow?.hide();
});

ipcMain.handle('show-recording-highlight', (event, sourceId) => {
  showRecordingHighlight(sourceId);
});

ipcMain.handle('hide-recording-highlight', () => {
  hideRecordingHighlight();
});

// Control window actions - forward to main renderer
ipcMain.handle('stop-recording-from-control', () => {
  console.log('[MAIN] stop-recording-from-control IPC received');

  // CRITICAL FIX: Ensure mainWindow is shown and focused before sending IPC
  // Hidden windows may not process IPC messages even with backgroundThrottling disabled
  if (mainWindow) {
    // Show the window first to ensure it can process the message
    mainWindow.show();

    // Send stop signal after a small delay to ensure window is ready
    setTimeout(() => {
      console.log('[MAIN] Sending stop-recording to mainWindow');
      mainWindow.webContents.send('stop-recording');
    }, 100);
  } else {
    console.error('[MAIN] mainWindow is null!');
  }
});

ipcMain.handle('cancel-recording-from-control', () => {
  // Tell main window to cancel recording (discard)
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('cancel-recording');
  });
});

ipcMain.handle('toggle-pause-from-control', () => {
  // Tell main window to toggle pause
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('toggle-pause');
  });
});

// Layout switching during recording
ipcMain.handle('switch-layout', (event, layout) => {
  // Forward layout change to main window
  if (mainWindow) {
    mainWindow.webContents.send('layout-change', layout);
  }
});

ipcMain.handle('get-store', (event, key) => {
  return store.get(key);
});

ipcMain.handle('set-store', (event, key, value) => {
  store.set(key, value);
});

ipcMain.handle('toggle-recents', () => {
  if (recentsWindow && !recentsWindow.isDestroyed()) {
    closeRecentsWindow();
  } else {
    createRecentsWindow();
  }
});

ipcMain.handle('close-recents', () => {
  closeRecentsWindow();
});

ipcMain.handle('toggle-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    closeSettingsWindow();
  } else {
    createSettingsWindow();
  }
});

ipcMain.handle('close-settings', () => {
  closeSettingsWindow();
});

// Teleprompter window controls
ipcMain.handle('toggle-teleprompter', () => {
  if (teleprompterWindow && !teleprompterWindow.isDestroyed()) {
    closeTeleprompterWindow();
  } else {
    createTeleprompterWindow();
  }
});

ipcMain.handle('close-teleprompter', () => {
  closeTeleprompterWindow();
});

// Blur overlay window controls
ipcMain.handle('toggle-blur-overlay', () => {
  if (blurOverlayWindow && !blurOverlayWindow.isDestroyed()) {
    closeBlurOverlayWindow();
  } else {
    createBlurOverlayWindow();
  }
});

ipcMain.handle('close-blur-overlay', () => {
  closeBlurOverlayWindow();
});

ipcMain.handle('add-blur-regions', (event, regions) => {
  // Forward blur regions to main window for metadata storage
  if (mainWindow) {
    mainWindow.webContents.send('blur-regions-added', regions);
  }
});

ipcMain.handle('upload-for-personalization', async (event, { filePath, cameraFilePath, hasEmbeddedBubble }) => {
  // This will upload to our backend for personalization
  // Supports two modes:
  // 1. Separate camera file for lip-sync (cameraFilePath set)
  // 2. Embedded bubble in screen recording (hasEmbeddedBubble=true)
  const axios = require('axios');
  const FormData = require('form-data');

  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));

  // Add camera file if provided (for lip-sync processing)
  if (cameraFilePath && fs.existsSync(cameraFilePath)) {
    form.append('camera_file', fs.createReadStream(cameraFilePath));
    console.log('Including camera file for lip-sync:', cameraFilePath);
  }

  // Flag if camera bubble is embedded in screen recording
  if (hasEmbeddedBubble) {
    form.append('has_embedded_bubble', 'true');
    console.log('Camera bubble is embedded in screen recording');
  }

  try {
    const response = await axios.post(`${API_URL}/api/videos/upload`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    return response.data;
  } catch (error) {
    console.error('Upload failed:', error);
    throw error;
  }
});

// Upload video to backend and return video ID for web editor
ipcMain.handle('upload-to-backend', async (event, { filePath, fileName }) => {
  const axios = require('axios');
  const FormData = require('form-data');

  console.log('Uploading to backend:', filePath, fileName);

  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), fileName || path.basename(filePath));

  try {
    const response = await axios.post(`${API_URL}/api/videos/upload`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    console.log('Upload response:', response.data);

    return {
      success: true,
      videoId: response.data.video_id,
      data: response.data,
    };
  } catch (error) {
    console.error('Upload to backend failed:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
});

// App lifecycle
app.whenReady().then(async () => {
  await checkPermissions();
  createMainWindow();
  createTray();
  setupGlobalShortcuts();

  // PERF: Pre-warm popup windows in background for instant display
  // Delay slightly to not block main window render
  setTimeout(() => {
    prewarmWindows();
  }, 500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

// Pre-warm frequently used windows (hidden) for instant show
let prewarmedRecents = null;
let prewarmedSettings = null;

function prewarmWindows() {
  // Pre-create recents window (hidden)
  if (!prewarmedRecents) {
    const { screen } = require('electron');
    const display = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = display.workAreaSize;

    prewarmedRecents = new BrowserWindow({
      width: 340,
      height: 360,
      x: Math.floor(screenWidth / 2 - 170),
      y: screenHeight - 460,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false, // Hidden until needed
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    prewarmedRecents.loadFile('renderer/recents.html');
  }

  // Pre-create settings window (hidden)
  if (!prewarmedSettings) {
    const { screen } = require('electron');
    const display = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = display.workAreaSize;

    prewarmedSettings = new BrowserWindow({
      width: 300,
      height: 320,
      x: Math.floor(screenWidth / 2 - 150),
      y: screenHeight - 420,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false, // Hidden until needed
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    prewarmedSettings.loadFile('renderer/settings.html');
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Handle certificate errors in development
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  if (url.startsWith('https://localhost')) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

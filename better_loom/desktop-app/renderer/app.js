// Soron Recorder - Minimal Floating Bar

class SoronRecorder {
  constructor() {
    this.selectedSource = null;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.isRecording = false;
    this.isPaused = false;
    this.recordingMode = 'screen-cam';
    this.hasEmbeddedBubble = false;

    // Capture mode: 'fullscreen' (bubbles captured) vs 'window' (separate files)
    this.captureMode = 'fullscreen';

    // Separate camera recording for window mode (enables post-processing bubble control)
    this.cameraRecorder = null;
    this.cameraChunks = [];

    // Premium features - metadata tracking
    this.recordingStartTime = null;
    this.clicks = [];           // Auto-zoom feature
    this.cursorPath = [];       // Cursor smoothing feature
    this.layoutChanges = [];    // Multi-layout feature
    this.blurRegions = [];      // Privacy blur feature
    this.currentLayout = 'pip'; // Current layout mode
    this.cursorInterval = null; // Cursor tracking interval
    this.screenDimensions = { width: 0, height: 0 };

    this.init();
  }

  // Layout configurations (normalized 0-1 coordinates)
  static LAYOUTS = {
    'pip': {
      screen: { x: 0, y: 0, w: 1, h: 1 },
      camera: { x: 0.02, y: 0.72, w: 0.26, h: 0.26, circular: true }
    },
    'screen': {
      screen: { x: 0, y: 0, w: 1, h: 1 },
      camera: null
    },
    'camera': {
      screen: null,
      camera: { x: 0, y: 0, w: 1, h: 1, circular: false }
    },
    'split': {
      screen: { x: 0, y: 0, w: 0.5, h: 1 },
      camera: { x: 0.5, y: 0, w: 0.5, h: 1, circular: false }
    }
  };

  async init() {
    this.setupRecordButtons();
    this.setupEventListeners();
    this.setupClickTracking();
    this.setupLayoutListener();
    this.setupBlurRegionListener();
  }

  // Listen for layout changes from recording control window
  setupLayoutListener() {
    window.soron.onLayoutChange((layout) => {
      this.setLayout(layout);
    });
  }

  // Listen for blur regions from blur overlay window
  setupBlurRegionListener() {
    window.soron.onBlurRegionsAdded((regions) => {
      if (!this.isRecording) return;

      const currentTime = this.getElapsedTime();

      // Add regions to metadata with timestamps
      for (const region of regions) {
        this.blurRegions.push({
          id: region.id,
          x: region.x,
          y: region.y,
          w: region.w,
          h: region.h,
          start: region.start || currentTime,
          end: region.end, // null means until end of recording
        });
      }

      console.log(`Added ${regions.length} blur regions, total: ${this.blurRegions.length}`);
      this.showNotification(`${regions.length} blur region(s) added`);
    });
  }

  // Switch to a new layout during recording
  setLayout(layoutName) {
    if (!SoronRecorder.LAYOUTS[layoutName]) return;
    if (!this.isRecording) return;

    this.currentLayout = layoutName;

    // Record the layout change in metadata
    this.layoutChanges.push({
      t: this.getElapsedTime(),
      layout: layoutName
    });

    console.log(`Layout changed to: ${layoutName}`);
  }

  // Get elapsed time since recording started (in seconds)
  getElapsedTime() {
    if (!this.recordingStartTime) return 0;
    return (Date.now() - this.recordingStartTime) / 1000;
  }

  // Track clicks for auto-zoom feature
  // Note: Actual click tracking happens in main process via addClickEvent IPC
  // This is just a fallback for clicks within the app window
  setupClickTracking() {
    // Click tracking is now handled by the "Mark" button in recording controls
    // and the main process tracks cursor position when Mark is pressed
  }

  // Start cursor position tracking (30fps)
  startCursorTracking() {
    if (this.cursorInterval) return;

    this.cursorInterval = setInterval(async () => {
      if (!this.isRecording || this.isPaused) return;

      try {
        const cursor = await window.soron.getCursorPosition();
        if (cursor && this.screenDimensions.width) {
          this.cursorPath.push({
            t: this.getElapsedTime(),
            x: cursor.x / this.screenDimensions.width,
            y: cursor.y / this.screenDimensions.height
          });
        }
      } catch (e) {
        // Cursor tracking not available
      }
    }, 33); // 30fps for smooth cursor data
  }

  stopCursorTracking() {
    if (this.cursorInterval) {
      clearInterval(this.cursorInterval);
      this.cursorInterval = null;
    }
  }

  // Generate metadata JSON for this recording
  generateMetadata(filename, duration) {
    // Finalize blur regions - set end time to duration if null
    const finalizedBlurRegions = this.blurRegions.map(r => ({
      ...r,
      end: r.end === null ? duration : r.end
    }));

    return {
      version: '1.0',
      videoFile: filename,
      createdAt: new Date().toISOString(),
      duration: duration,
      resolution: this.screenDimensions,
      features: {
        clicks: this.clicks,
        cursorPath: this.cursorPath,
        layoutChanges: this.layoutChanges,
        blurRegions: finalizedBlurRegions
      },
      settings: {
        autoZoom: true,
        cursorEffects: true,
        recordingMode: this.recordingMode
      }
    };
  }

  // Reset metadata for new recording
  resetMetadata() {
    this.clicks = [];
    this.cursorPath = [];
    this.layoutChanges = [];
    this.blurRegions = [];
    this.recordingStartTime = null;
  }

  setupRecordButtons() {
    // Screen + Camera
    document.getElementById('record-screen-cam').addEventListener('click', async () => {
      this.recordingMode = 'screen-cam';
      await this.showSourcePicker(true);
    });

    // Screen Only
    document.getElementById('record-screen').addEventListener('click', async () => {
      this.recordingMode = 'screen';
      await this.showSourcePicker(false);
    });

    // Camera Only
    document.getElementById('record-camera').addEventListener('click', () => {
      this.recordingMode = 'camera';
      this.startCameraOnlyRecording();
    });

    // Recents - opens separate window
    const recentsToggle = document.getElementById('recents-toggle');
    recentsToggle.addEventListener('click', () => {
      recentsToggle.classList.toggle('active');
      window.soron.toggleRecents();
    });

    // Listen for recents window closing
    window.soron.onRecentsClosed(() => {
      recentsToggle.classList.remove('active');
    });

    // Settings - opens separate window
    const settingsBtn = document.getElementById('settings-btn');
    settingsBtn.addEventListener('click', () => {
      settingsBtn.classList.toggle('active');
      window.soron.toggleSettings();
    });

    // Listen for settings window closing
    window.soron.onSettingsClosed(() => {
      settingsBtn.classList.remove('active');
    });

    // Features popup - click toggle
    const featuresBtn = document.getElementById('features-btn');
    const featuresPopup = document.getElementById('features-popup');

    if (featuresBtn && featuresPopup) {
      featuresBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        featuresBtn.classList.toggle('active');
        featuresPopup.classList.toggle('show');
      });

      // Close when clicking outside
      document.addEventListener('click', (e) => {
        if (!featuresPopup.contains(e.target) && e.target !== featuresBtn) {
          featuresBtn.classList.remove('active');
          featuresPopup.classList.remove('show');
        }
      });
    }
  }

  setupEventListeners() {
    window.soron.onStopRecording(() => {
      this.stopRecording();
    });

    window.soron.onCancelRecording && window.soron.onCancelRecording(() => {
      this.cancelRecording();
    });

    window.soron.onTogglePause(() => {
      this.togglePause();
    });
  }

  async showSourcePicker(includeCamera) {
    // Get available sources
    const sources = await window.soron.getSources();
    const screens = sources.filter(s => s.id.startsWith('screen:'));
    const windows = sources.filter(s =>
      s.id.startsWith('window:') &&
      !s.name.toLowerCase().includes('soron')
    );

    // Show picker via IPC (main process will show native picker or custom UI)
    const result = await window.soron.showSourcePicker({ screens, windows });

    if (!result || result.cancelled) return;

    this.captureMode = result.mode; // 'fullscreen' or 'window'
    this.selectedSource = result.source;

    // In fullscreen mode with camera, bubbles ARE the overlay (embedded)
    // In window mode with camera, we use canvas compositing
    this.hasEmbeddedBubble = this.captureMode === 'fullscreen' && includeCamera;

    await this.startRecording(includeCamera);
  }

  async selectSourceAndRecord(includeCamera) {
    try {
      // Get available sources
      const sources = await window.soron.getSources();

      let selectedSource;

      if (this.captureMode === 'window') {
        // Window mode: Show picker for windows (excluding our app windows)
        const windows = sources.filter(s =>
          s.id.startsWith('window:') &&
          !s.name.toLowerCase().includes('soron')
        );

        if (windows.length === 0) {
          this.showNotification('No windows available');
          return;
        }

        // For now, use the first window (TODO: add picker UI)
        // Prefer active/focused windows
        selectedSource = windows[0];
        console.log('Window mode: capturing', selectedSource.name);
      } else {
        // Full screen mode: Use first screen
        selectedSource = sources.find(s => s.id.startsWith('screen:'));
        if (!selectedSource) {
          this.showNotification('No screen available');
          return;
        }
        console.log('Full screen mode: capturing entire screen');
      }

      this.selectedSource = selectedSource;
      // In fullscreen mode with camera, bubbles ARE the overlay (embedded)
      // In window mode with camera, we use canvas compositing
      this.hasEmbeddedBubble = this.captureMode === 'fullscreen' && includeCamera;
      await this.startRecording(includeCamera);

    } catch (err) {
      console.error('Error selecting source:', err);
      this.showNotification('Error: ' + err.message);
    }
  }

  async startRecording(includeCamera) {
    if (!this.selectedSource) return;

    const sourceId = this.selectedSource.id;

    // Capture screen dimensions for metadata normalization
    try {
      const screenInfo = await window.soron.getScreenDimensions();
      this.screenDimensions = screenInfo || { width: 1920, height: 1080 };
    } catch (e) {
      this.screenDimensions = { width: 1920, height: 1080 };
    }

    // Set initial layout based on recording mode
    this.currentLayout = includeCamera ? 'pip' : 'screen';

    try {
      // PERF: Parallelize all media capture requests for faster startup
      const mediaPromises = [
        // Screen capture (required)
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
            }
          }
        }),
        // Microphone (optional, catch errors)
        navigator.mediaDevices.getUserMedia({ audio: true, video: false })
          .catch(() => null),
      ];

      // Add camera if needed - prefer built-in webcam over iPhone Continuity Camera
      if (includeCamera) {
        mediaPromises.push(
          (async () => {
            try {
              // Get list of video devices
              const devices = await navigator.mediaDevices.enumerateDevices();
              const videoDevices = devices.filter(d => d.kind === 'videoinput');

              // Prefer built-in camera (FaceTime, iSight) over iPhone/external
              const builtIn = videoDevices.find(d =>
                d.label.toLowerCase().includes('facetime') ||
                d.label.toLowerCase().includes('isight') ||
                d.label.toLowerCase().includes('built-in')
              );

              const deviceId = builtIn?.deviceId || videoDevices[0]?.deviceId;

              return navigator.mediaDevices.getUserMedia({
                video: {
                  deviceId: deviceId ? { exact: deviceId } : undefined,
                  width: { ideal: 1280, min: 640 },
                  height: { ideal: 720, min: 480 },
                  frameRate: { ideal: 30 }
                },
                audio: false
              });
            } catch (e) {
              console.error('Camera error:', e);
              return null;
            }
          })()
        );
      }

      // Wait for all media streams in parallel
      const [screenStream, audioStream, cameraStream] = await Promise.all(mediaPromises);

      let recordingStream;

      // Full screen mode: bubble captured in screen recording
      // Window mode: record screen + camera separately for post-processing control
      if (cameraStream && this.captureMode === 'window') {
        // Window mode: Record screen and camera SEPARATELY
        // This enables post-processing bubble control (position, size, visibility)
        const tracks = [...screenStream.getVideoTracks()];
        if (audioStream) tracks.push(...audioStream.getAudioTracks());
        recordingStream = new MediaStream(tracks);

        // Start separate camera recording
        this.startCameraRecording(cameraStream);
      } else {
        // Full screen mode OR no camera: record screen directly
        // Camera bubble window will be captured as part of screen
        const tracks = [...screenStream.getVideoTracks()];
        if (audioStream) tracks.push(...audioStream.getAudioTracks());
        recordingStream = new MediaStream(tracks);
      }

      this.startMediaRecording(recordingStream);
      await window.soron.recordingStarted(sourceId, includeCamera, this.captureMode);

    } catch (err) {
      console.error('Error starting recording:', err);
      this.showNotification('Error: ' + err.message);
    }
  }

  async createCompositeStream(screenStream, cameraStream, audioStream) {
    const screenVideo = document.createElement('video');
    screenVideo.srcObject = screenStream;
    screenVideo.muted = true;
    await screenVideo.play();

    const cameraVideo = document.createElement('video');
    cameraVideo.srcObject = cameraStream;
    cameraVideo.muted = true;
    await cameraVideo.play();

    await new Promise(resolve => {
      const check = () => {
        if (screenVideo.videoWidth > 0 && cameraVideo.videoWidth > 0) resolve();
        else requestAnimationFrame(check);
      };
      check();
    });

    const canvas = document.createElement('canvas');
    canvas.width = screenVideo.videoWidth;
    canvas.height = screenVideo.videoHeight;
    const ctx = canvas.getContext('2d', { alpha: false }); // No transparency = minor perf gain, no quality loss

    this.compositeCanvas = canvas;
    this.compositeCtx = ctx;
    this.screenVideo = screenVideo;
    this.cameraVideo = cameraVideo;
    this.cameraStream = cameraStream;

    const drawFrame = () => {
      if (!this.isRecording) return;

      const layout = SoronRecorder.LAYOUTS[this.currentLayout];
      const W = canvas.width;
      const H = canvas.height;

      // Clear canvas
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);

      // Draw screen if layout includes it
      if (layout.screen) {
        const s = layout.screen;
        ctx.drawImage(screenVideo, s.x * W, s.y * H, s.w * W, s.h * H);
      }

      // Draw camera if layout includes it
      if (layout.camera && cameraVideo.videoWidth > 0) {
        const c = layout.camera;
        const camX = c.x * W;
        const camY = c.y * H;
        const camW = c.w * W;
        const camH = c.h * H;

        // Calculate camera source crop to match destination aspect ratio
        const srcAspect = cameraVideo.videoWidth / cameraVideo.videoHeight;
        const dstAspect = camW / camH;
        let srcX = 0, srcY = 0, srcW = cameraVideo.videoWidth, srcH = cameraVideo.videoHeight;

        if (srcAspect > dstAspect) {
          // Source is wider - crop sides
          srcW = cameraVideo.videoHeight * dstAspect;
          srcX = (cameraVideo.videoWidth - srcW) / 2;
        } else {
          // Source is taller - crop top/bottom
          srcH = cameraVideo.videoWidth / dstAspect;
          srcY = (cameraVideo.videoHeight - srcH) / 2;
        }

        ctx.save();

        // Circular clip for PIP bubble
        if (c.circular) {
          const centerX = camX + camW / 2;
          const centerY = camY + camH / 2;
          const radius = Math.min(camW, camH) / 2;
          ctx.beginPath();
          ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
          ctx.closePath();
          ctx.clip();
        }

        // Mirror horizontally and draw camera
        ctx.translate(camX + camW, camY);
        ctx.scale(-1, 1);
        ctx.drawImage(cameraVideo, srcX, srcY, srcW, srcH, 0, 0, camW, camH);
        ctx.restore();

        // Draw border for circular bubble
        if (c.circular) {
          const centerX = camX + camW / 2;
          const centerY = camY + camH / 2;
          const radius = Math.min(camW, camH) / 2;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(centerX, centerY, radius - 1, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      this.compositeAnimationId = requestAnimationFrame(drawFrame);
    };

    this.isRecording = true;
    drawFrame();

    const canvasStream = canvas.captureStream(30);
    const tracks = [...canvasStream.getVideoTracks()];
    if (audioStream) tracks.push(...audioStream.getAudioTracks());

    return new MediaStream(tracks);
  }

  async startCameraOnlyRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'user' },
        audio: true
      });

      this.startMediaRecording(stream);
      this.cameraStream = stream;
      await window.soron.recordingStarted(null);

    } catch (err) {
      console.error('Error starting camera recording:', err);
      this.showNotification('Error: ' + err.message);
    }
  }

  async startMediaRecording(stream) {
    this.recordedChunks = [];
    this.isRecording = true;
    this.isPaused = false;

    // Reset and start metadata tracking
    this.resetMetadata();
    this.recordingStartTime = Date.now();

    // Record initial layout
    this.layoutChanges.push({
      t: 0,
      layout: this.currentLayout
    });

    // Start click tracking in main process (for Mark button)
    await window.soron.startClickTracking();

    // Start cursor tracking for smoothing feature
    this.startCursorTracking();

    // VP9 = higher quality at same bitrate (worth the CPU cost)
    const options = { mimeType: 'video/webm;codecs=vp9,opus', videoBitsPerSecond: 5000000 };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options.mimeType = 'video/webm;codecs=vp8,opus';
    }

    this.mediaRecorder = new MediaRecorder(stream, options);
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.recordedChunks.push(e.data);
    };
    this.mediaRecorder.onstop = () => this.saveRecording();
    // 100ms chunks = snappier stop (max 100ms wait vs 1s)
    // CPU overhead is negligible, quality identical
    this.mediaRecorder.start(100);
  }

  // Start separate camera recording for window mode (enables post-processing bubble control)
  startCameraRecording(cameraStream) {
    this.cameraChunks = [];

    const options = { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 2000000 };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options.mimeType = 'video/webm;codecs=vp8';
    }

    this.cameraRecorder = new MediaRecorder(cameraStream, options);
    this.cameraRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.cameraChunks.push(e.data);
    };
    this.cameraRecorder.start(100);
    console.log('Camera recording started (separate file for post-processing)');
  }

  togglePause() {
    if (!this.mediaRecorder) return;
    if (this.isPaused) {
      this.mediaRecorder.resume();
      if (this.cameraRecorder) this.cameraRecorder.resume();
      this.isPaused = false;
    } else {
      this.mediaRecorder.pause();
      if (this.cameraRecorder) this.cameraRecorder.pause();
      this.isPaused = true;
    }
  }

  cancelRecording() {
    if (!this.mediaRecorder || !this.isRecording) return;
    this.isRecording = false;
    this.recordedChunks = [];
    this.cameraChunks = [];
    this.mediaRecorder.stop();
    this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
    if (this.cameraRecorder) {
      this.cameraRecorder.stop();
      this.cameraRecorder.stream.getTracks().forEach(track => track.stop());
      this.cameraRecorder = null;
    }
    window.soron.recordingStopped();
  }

  stopRecording() {
    if (!this.mediaRecorder || !this.isRecording) return;

    this.isRecording = false;
    this.stopCursorTracking();

    // Stop camera recorder first (if exists) and wait for it
    if (this.cameraRecorder && this.cameraRecorder.state !== 'inactive') {
      this.cameraRecorder.stop();
      this.cameraRecorder.stream.getTracks().forEach(track => track.stop());
    }

    // Stop main recorder (triggers saveRecording via onstop)
    this.mediaRecorder.stop();
    this.mediaRecorder.stream.getTracks().forEach(track => track.stop());

    if (this.compositeAnimationId) {
      cancelAnimationFrame(this.compositeAnimationId);
      this.compositeAnimationId = null;
    }

    if (this.cameraStream) {
      this.cameraStream.getTracks().forEach(track => track.stop());
      this.cameraStream = null;
    }

    if (this.screenVideo) { this.screenVideo.srcObject = null; this.screenVideo = null; }
    if (this.cameraVideo) { this.cameraVideo.srcObject = null; this.cameraVideo = null; }
  }

  async saveRecording() {
    // PERF: Show instant feedback before processing
    this.showNotification('Processing recording...');

    const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `soron-recording-${timestamp}.webm`;

    // Calculate recording duration
    const duration = this.recordingStartTime ? (Date.now() - this.recordingStartTime) / 1000 : 0;

    // Check if we have separate camera recording (window mode)
    const hasSeparateCamera = this.cameraChunks.length > 0;
    let cameraBlob = null;
    let cameraFilename = null;

    if (hasSeparateCamera) {
      cameraBlob = new Blob(this.cameraChunks, { type: 'video/webm' });
      cameraFilename = `soron-camera-${timestamp}.webm`;
    }

    // PERF: Run these in parallel
    const [buffer, trackedClicks] = await Promise.all([
      blob.arrayBuffer(),
      window.soron.stopClickTracking(),
    ]);
    this.clicks = trackedClicks || [];

    try {
      // Save video file
      const filePath = await window.soron.saveRecording(buffer, filename);

      // Save camera file if exists
      let cameraFilePath = null;
      if (cameraBlob) {
        const cameraBuffer = await cameraBlob.arrayBuffer();
        cameraFilePath = await window.soron.saveRecording(cameraBuffer, cameraFilename);
        console.log('Saved separate camera file:', cameraFilePath);
      }

      // Save metadata sidecar file (includes camera info for post-processing)
      const metadata = this.generateMetadata(filename, duration);
      if (hasSeparateCamera) {
        metadata.separateCamera = {
          filename: cameraFilename,
          bubbleSettings: {
            position: 'bottom-left',
            size: 0.25, // 25% of screen width
            shape: 'circle',
            visibility: [] // Array of {start, end, visible} for time-based visibility
          }
        };
      }
      await window.soron.saveMetadata(filename, metadata);

      await window.soron.recordingStopped();

      // PERF: Clear chunks immediately to free memory
      this.recordedChunks = [];
      this.cameraChunks = [];
      this.cameraRecorder = null;

      // Check auto-upload setting (local-first feature)
      const autoUpload = await window.soron.getStore('autoUpload');
      const shouldUpload = autoUpload !== false; // Default to true if not set

      if (shouldUpload) {
        this.showNotification('Recording saved, uploading...');

        // Upload with camera file path if exists
        const uploadResult = await window.soron.uploadForPersonalization(
          filePath,
          cameraFilePath, // Pass camera file for separate compositing
          this.hasEmbeddedBubble
        );
        await this.triggerProcessing(uploadResult.video_id);

        const editorUrl = `http://localhost:3000?video=${uploadResult.video_id}`;
        window.soron.openExternal(editorUrl);
      } else {
        this.showNotification('Recording saved locally');
        // Open in Finder/Explorer
        await window.soron.showInFolder(filePath);
      }

    } catch (err) {
      console.error('Error processing recording:', err);
      this.showNotification('Error: ' + err.message);
      await window.soron.recordingStopped().catch(() => {});
    }
  }

  async triggerProcessing(videoId) {
    const apiUrl = await window.soron.getStore('apiUrl') || 'http://127.0.0.1:8000';

    try {
      const response = await fetch(`${apiUrl}/api/videos/${videoId}/process`, { method: 'POST' });
      if (!response.ok) {
        await this.triggerProcessingSequential(videoId, apiUrl);
      }
    } catch (err) {
      await this.triggerProcessingSequential(videoId, apiUrl);
    }
  }

  async triggerProcessingSequential(videoId, apiUrl) {
    try {
      await fetch(`${apiUrl}/api/videos/${videoId}/transcribe`, { method: 'POST' });
    } catch (err) {}
    try {
      await fetch(`${apiUrl}/api/videos/${videoId}/analyze`, { method: 'POST' });
    } catch (err) {}
  }

  showNotification(message) {
    const existing = document.querySelector('.notification');
    if (existing) existing.remove();

    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.textContent = message;
    notification.style.cssText = `
      position: fixed;
      top: 12px;
      left: 50%;
      transform: translateX(-50%) translateY(-20px);
      background: rgba(30, 30, 35, 0.95);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.9);
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 500;
      z-index: 9999;
      white-space: nowrap;
      opacity: 0;
      transition: transform 0.15s ease-out, opacity 0.15s ease-out;
      will-change: transform, opacity;
    `;

    document.body.appendChild(notification);

    // Trigger animation on next frame (instant feel)
    requestAnimationFrame(() => {
      notification.style.transform = 'translateX(-50%) translateY(0)';
      notification.style.opacity = '1';
    });

    // Fade out and remove
    setTimeout(() => {
      notification.style.transform = 'translateX(-50%) translateY(-10px)';
      notification.style.opacity = '0';
      setTimeout(() => notification.remove(), 150);
    }, 2000);
  }
}

// Initialize
const app = new SoronRecorder();

// Mouse event forwarding for transparent areas
// When mouse is over transparent parts, let events pass through to apps behind
(function setupMouseForwarding() {
  const controlBar = document.querySelector('.control-bar');
  const featuresPopup = document.getElementById('features-popup');

  if (!controlBar) return;

  let isIgnoring = false;

  // Check if element or any parent is interactive
  function isOverInteractive(el) {
    while (el) {
      if (el === controlBar || el === featuresPopup) return true;
      if (el.classList && (el.classList.contains('control-bar') || el.classList.contains('features-popup'))) return true;
      el = el.parentElement;
    }
    return false;
  }

  // Track mouse movement to toggle ignore state
  document.addEventListener('mousemove', (e) => {
    const shouldIgnore = !isOverInteractive(e.target);

    if (shouldIgnore !== isIgnoring) {
      isIgnoring = shouldIgnore;
      if (shouldIgnore) {
        window.soron.setIgnoreMouseEvents(true, { forward: true });
      } else {
        window.soron.setIgnoreMouseEvents(false);
      }
    }
  });

  // When mouse leaves window entirely, reset to not ignoring
  document.addEventListener('mouseleave', () => {
    if (isIgnoring) {
      isIgnoring = false;
      window.soron.setIgnoreMouseEvents(false);
    }
  });
})();

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
      await this.selectSourceAndRecord(true);
    });

    // Screen Only
    document.getElementById('record-screen').addEventListener('click', async () => {
      this.recordingMode = 'screen';
      await this.selectSourceAndRecord(false);
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

  async selectSourceAndRecord(includeCamera) {
    try {
      // Get available sources
      const sources = await window.soron.getSources();

      // For now, just use the first screen
      const screenSource = sources.find(s => s.id.startsWith('screen:'));
      if (!screenSource) {
        this.showNotification('No screen available');
        return;
      }

      this.selectedSource = screenSource;
      this.hasEmbeddedBubble = includeCamera;
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

      // Add camera if needed
      if (includeCamera) {
        mediaPromises.push(
          navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
            audio: false
          }).catch(() => null)
        );
      }

      // Wait for all media streams in parallel
      const [screenStream, audioStream, cameraStream] = await Promise.all(mediaPromises);

      let recordingStream;
      if (cameraStream) {
        recordingStream = await this.createCompositeStream(screenStream, cameraStream, audioStream);
      } else {
        const tracks = [...screenStream.getVideoTracks()];
        if (audioStream) tracks.push(...audioStream.getAudioTracks());
        recordingStream = new MediaStream(tracks);
      }

      this.startMediaRecording(recordingStream);
      await window.soron.recordingStarted(sourceId, includeCamera);

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

        // Calculate camera source crop (center crop for square aspect)
        const camAspect = cameraVideo.videoWidth / cameraVideo.videoHeight;
        let srcX = 0, srcY = 0, srcW = cameraVideo.videoWidth, srcH = cameraVideo.videoHeight;
        if (camAspect > 1) {
          srcW = cameraVideo.videoHeight;
          srcX = (cameraVideo.videoWidth - srcW) / 2;
        } else {
          srcH = cameraVideo.videoWidth;
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

  togglePause() {
    if (!this.mediaRecorder) return;
    if (this.isPaused) {
      this.mediaRecorder.resume();
      this.isPaused = false;
    } else {
      this.mediaRecorder.pause();
      this.isPaused = true;
    }
  }

  cancelRecording() {
    if (!this.mediaRecorder || !this.isRecording) return;
    this.isRecording = false;
    this.recordedChunks = [];
    this.mediaRecorder.stop();
    this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
    window.soron.recordingStopped();
  }

  stopRecording() {
    if (!this.mediaRecorder || !this.isRecording) return;

    this.isRecording = false;
    this.stopCursorTracking(); // Stop cursor tracking
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

    // PERF: Run these in parallel
    const [buffer, trackedClicks] = await Promise.all([
      blob.arrayBuffer(),
      window.soron.stopClickTracking(),
    ]);
    this.clicks = trackedClicks || [];

    try {
      // Save video file
      const filePath = await window.soron.saveRecording(buffer, filename);

      // Save metadata sidecar file
      const metadata = this.generateMetadata(filename, duration);
      await window.soron.saveMetadata(filename, metadata);

      await window.soron.recordingStopped();

      // PERF: Clear chunks immediately to free memory
      this.recordedChunks = [];

      // Check auto-upload setting (local-first feature)
      const autoUpload = await window.soron.getStore('autoUpload');
      const shouldUpload = autoUpload !== false; // Default to true if not set

      if (shouldUpload) {
        this.showNotification('Recording saved, uploading...');

        const uploadResult = await window.soron.uploadForPersonalization(filePath, null, this.hasEmbeddedBubble);
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

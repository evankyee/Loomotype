// Soron Recorder - Main Application Logic

class SoronRecorder {
  constructor() {
    this.selectedSource = null;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.isRecording = false;
    this.isPaused = false;
    this.recordingStartTime = null;
    this.recordingMode = 'screen-cam'; // 'screen-cam', 'screen', 'camera'

    this.init();
  }

  async init() {
    this.setupNavigation();
    this.setupRecordButtons();
    this.setupModal();
    this.setupSettings();
    this.loadRecordings();
    this.setupEventListeners();
  }

  setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');

    navItems.forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();

        // Update active nav
        navItems.forEach(nav => nav.classList.remove('active'));
        item.classList.add('active');

        // Show corresponding view
        const viewId = item.dataset.view;
        this.showView(viewId);
      });
    });
  }

  showView(viewId) {
    const views = document.querySelectorAll('.view');
    views.forEach(view => view.classList.remove('active'));

    const targetView = document.getElementById(`${viewId}-view`);
    if (targetView) {
      targetView.classList.add('active');
    }

    // Refresh data for certain views
    if (viewId === 'recordings') {
      this.loadRecordings();
    }
  }

  setupRecordButtons() {
    document.getElementById('record-screen-cam').addEventListener('click', () => {
      this.recordingMode = 'screen-cam';
      this.openSourceModal();
    });

    document.getElementById('record-screen').addEventListener('click', () => {
      this.recordingMode = 'screen';
      this.openSourceModal();
    });

    document.getElementById('record-camera').addEventListener('click', () => {
      this.recordingMode = 'camera';
      this.startCameraOnlyRecording();
    });
  }

  setupModal() {
    const modal = document.getElementById('source-modal');
    const closeBtn = modal.querySelector('.modal-close');
    const startBtn = document.getElementById('start-recording');
    const tabs = modal.querySelectorAll('.tab');

    closeBtn.addEventListener('click', () => this.closeModal());

    modal.addEventListener('click', (e) => {
      if (e.target === modal) this.closeModal();
    });

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.filterSources(tab.dataset.tab);
      });
    });

    startBtn.addEventListener('click', () => this.startRecording());
  }

  setupSettings() {
    // Load saved settings
    this.loadSettings();

    // Setup device selectors
    this.populateDevices();

    // Save settings on change
    document.getElementById('video-quality').addEventListener('change', (e) => {
      window.soron.setStore('videoQuality', e.target.value);
    });

    document.getElementById('frame-rate').addEventListener('change', (e) => {
      window.soron.setStore('frameRate', e.target.value);
    });

    document.getElementById('api-url').addEventListener('blur', (e) => {
      window.soron.setStore('apiUrl', e.target.value);
    });

    document.getElementById('api-key').addEventListener('blur', (e) => {
      window.soron.setStore('apiKey', e.target.value);
    });
  }

  async loadSettings() {
    const videoQuality = await window.soron.getStore('videoQuality') || '1080p';
    const frameRate = await window.soron.getStore('frameRate') || '30';
    const apiUrl = await window.soron.getStore('apiUrl') || '';
    const apiKey = await window.soron.getStore('apiKey') || '';

    document.getElementById('video-quality').value = videoQuality;
    document.getElementById('frame-rate').value = frameRate;
    document.getElementById('api-url').value = apiUrl;
    document.getElementById('api-key').value = apiKey;
  }

  async populateDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();

      const micSelect = document.getElementById('microphone-select');
      const camSelect = document.getElementById('camera-select');

      // Clear existing options
      micSelect.innerHTML = '';
      camSelect.innerHTML = '';

      // Separate cameras into built-in vs external (like iPhone Continuity Camera)
      const cameras = devices.filter(d => d.kind === 'videoinput');
      const mics = devices.filter(d => d.kind === 'audioinput');

      // Sort cameras: prefer built-in/FaceTime cameras, deprioritize phone cameras
      cameras.sort((a, b) => {
        const labelA = (a.label || '').toLowerCase();
        const labelB = (b.label || '').toLowerCase();

        // iPhone/phone cameras go last
        const isPhoneA = labelA.includes('iphone') || labelA.includes('android') || labelA.includes('continuity');
        const isPhoneB = labelB.includes('iphone') || labelB.includes('android') || labelB.includes('continuity');

        if (isPhoneA && !isPhoneB) return 1;  // A is phone, B is not -> B first
        if (!isPhoneA && isPhoneB) return -1; // B is phone, A is not -> A first

        // FaceTime/built-in cameras go first
        const isBuiltInA = labelA.includes('facetime') || labelA.includes('built-in') || labelA.includes('integrated');
        const isBuiltInB = labelB.includes('facetime') || labelB.includes('built-in') || labelB.includes('integrated');

        if (isBuiltInA && !isBuiltInB) return -1;
        if (!isBuiltInA && isBuiltInB) return 1;

        return 0;
      });

      // Add cameras to select (sorted)
      cameras.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.text = device.label || `Camera ${device.deviceId.slice(0, 8)}`;
        camSelect.appendChild(option);
      });

      // Add mics to select
      mics.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.text = device.label || `Microphone ${device.deviceId.slice(0, 8)}`;
        micSelect.appendChild(option);
      });
    } catch (err) {
      console.error('Error enumerating devices:', err);
    }
  }

  setupEventListeners() {
    // Listen for stop recording from main process (saves recording)
    console.log('[APP.JS] Setting up stop-recording listener');
    window.soron.onStopRecording(() => {
      console.log('[APP.JS] Received stop-recording event!');
      console.log('[APP.JS] mediaRecorder:', this.mediaRecorder);
      console.log('[APP.JS] isRecording:', this.isRecording);
      this.stopRecording();
    });

    // Listen for cancel recording from main process (discards recording)
    window.soron.onCancelRecording && window.soron.onCancelRecording(() => {
      this.cancelRecording();
    });

    window.soron.onTogglePause(() => {
      this.togglePause();
    });

    window.soron.onOpenSettings(() => {
      this.showView('settings');
    });
  }

  cancelRecording() {
    if (!this.mediaRecorder || !this.isRecording) return;

    this.isRecording = false;
    this.recordedChunks = []; // Discard chunks
    this.mediaRecorder.stop();

    // Stop all tracks
    this.mediaRecorder.stream.getTracks().forEach(track => track.stop());

    // Just notify stopped, don't save
    window.soron.recordingStopped();
  }

  async openSourceModal() {
    const modal = document.getElementById('source-modal');
    modal.classList.add('active');

    // Update checkbox visibility based on mode
    document.getElementById('include-camera').parentElement.style.display =
      this.recordingMode === 'screen-cam' ? 'flex' : 'none';

    // Load sources
    await this.loadSources();
  }

  closeModal() {
    const modal = document.getElementById('source-modal');
    modal.classList.remove('active');
    this.selectedSource = null;
    document.getElementById('start-recording').disabled = true;
  }

  async loadSources() {
    const sources = await window.soron.getSources();
    const grid = document.getElementById('sources-grid');

    grid.innerHTML = '';

    this.allSources = sources;
    this.filterSources('screens');
  }

  filterSources(type) {
    const grid = document.getElementById('sources-grid');
    grid.innerHTML = '';

    const filtered = this.allSources.filter(source => {
      if (type === 'screens') {
        return source.id.startsWith('screen:');
      } else {
        return source.id.startsWith('window:');
      }
    });

    filtered.forEach(source => {
      const item = document.createElement('div');
      item.className = 'source-item';
      item.dataset.id = source.id;

      item.innerHTML = `
        <div class="source-thumbnail">
          <img src="${source.thumbnail}" alt="${source.name}">
        </div>
        <div class="source-name">${source.name}</div>
      `;

      item.addEventListener('click', () => this.selectSource(source, item));

      grid.appendChild(item);
    });
  }

  selectSource(source, element) {
    // Remove previous selection
    document.querySelectorAll('.source-item').forEach(item => {
      item.classList.remove('selected');
    });

    // Select this one
    element.classList.add('selected');
    this.selectedSource = source;

    // Enable start button
    document.getElementById('start-recording').disabled = false;
  }

  async startRecording() {
    if (!this.selectedSource || !this.selectedSource.id) {
      alert('Please select a screen or window to record first.');
      return;
    }

    const sourceId = this.selectedSource.id;
    console.log('Starting recording with source:', sourceId);

    this.closeModal();

    try {
      // Get screen stream
      const screenStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
          }
        }
      });

      // Get options
      const includeMic = document.getElementById('include-mic').checked;
      const includeCamera = document.getElementById('include-camera').checked;

      // Track if camera bubble is embedded (for upload metadata)
      this.hasEmbeddedBubble = includeCamera;

      let audioStream = null;
      if (includeMic) {
        audioStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false
        });
      }

      // Get camera stream if enabled
      let cameraStream = null;
      if (includeCamera) {
        const selectedCameraId = document.getElementById('camera-select')?.value;
        const videoConstraints = {
          width: { ideal: 640 },
          height: { ideal: 480 },
        };
        if (selectedCameraId) {
          videoConstraints.deviceId = { exact: selectedCameraId };
        }
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false
        });
      }

      // Create composite stream with camera bubble embedded
      let recordingStream;
      if (cameraStream) {
        recordingStream = await this.createCompositeStream(screenStream, cameraStream, audioStream);
        console.log('Created composite stream with embedded camera bubble');
      } else {
        // No camera - just use screen stream
        const tracks = [...screenStream.getVideoTracks()];
        if (audioStream) {
          tracks.push(...audioStream.getAudioTracks());
        }
        recordingStream = new MediaStream(tracks);
      }

      // Start recording the composite stream
      this.startMediaRecording(recordingStream);

      // Tell main process to show recording controls
      // Pass includeCamera=true to show preview bubble window (for user feedback only)
      // The bubble won't be captured when recording a window - that's fine,
      // we're compositing it directly into the stream via canvas
      await window.soron.recordingStarted(sourceId, includeCamera);
      console.log('Screen recording started' + (includeCamera ? ' (camera composited into stream)' : ''));

    } catch (err) {
      console.error('Error starting recording:', err);
      alert('Failed to start recording: ' + err.message);
    }
  }

  async createCompositeStream(screenStream, cameraStream, audioStream) {
    // Create hidden video elements for screen and camera
    const screenVideo = document.createElement('video');
    screenVideo.srcObject = screenStream;
    screenVideo.muted = true;
    await screenVideo.play();

    const cameraVideo = document.createElement('video');
    cameraVideo.srcObject = cameraStream;
    cameraVideo.muted = true;
    await cameraVideo.play();

    // Wait for video dimensions to be available
    await new Promise(resolve => {
      const checkDimensions = () => {
        if (screenVideo.videoWidth > 0 && cameraVideo.videoWidth > 0) {
          resolve();
        } else {
          requestAnimationFrame(checkDimensions);
        }
      };
      checkDimensions();
    });

    // Create canvas for compositing
    const canvas = document.createElement('canvas');
    canvas.width = screenVideo.videoWidth;
    canvas.height = screenVideo.videoHeight;
    const ctx = canvas.getContext('2d');

    // Bubble settings - must match server expectations
    // Larger bubble (400px) for better face detection during lip-sync
    const bubbleSize = 400;
    const padding = 30;
    const bubbleX = padding;
    const bubbleY = canvas.height - bubbleSize - padding;

    // Store references for cleanup
    this.compositeCanvas = canvas;
    this.compositeCtx = ctx;
    this.screenVideo = screenVideo;
    this.cameraVideo = cameraVideo;
    this.cameraStream = cameraStream;
    this.compositeAnimationId = null;

    // Draw loop - composites screen + camera bubble
    const drawFrame = () => {
      if (!this.isRecording) {
        return; // Stop drawing when not recording
      }

      // Draw screen
      ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);

      // Draw camera as circular bubble
      ctx.save();

      // Create circular clipping path
      ctx.beginPath();
      ctx.arc(
        bubbleX + bubbleSize / 2,
        bubbleY + bubbleSize / 2,
        bubbleSize / 2,
        0,
        Math.PI * 2
      );
      ctx.closePath();
      ctx.clip();

      // Draw camera (scaled and cropped to fit bubble)
      const camAspect = cameraVideo.videoWidth / cameraVideo.videoHeight;
      let srcX = 0, srcY = 0, srcW = cameraVideo.videoWidth, srcH = cameraVideo.videoHeight;

      // Crop to square (center crop)
      if (camAspect > 1) {
        srcW = cameraVideo.videoHeight;
        srcX = (cameraVideo.videoWidth - srcW) / 2;
      } else {
        srcH = cameraVideo.videoWidth;
        srcY = (cameraVideo.videoHeight - srcH) / 2;
      }

      // Mirror the camera (flip horizontally)
      ctx.translate(bubbleX + bubbleSize, bubbleY);
      ctx.scale(-1, 1);
      ctx.drawImage(
        cameraVideo,
        srcX, srcY, srcW, srcH,
        0, 0, bubbleSize, bubbleSize
      );

      ctx.restore();

      // Optional: Add subtle border to bubble
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(
        bubbleX + bubbleSize / 2,
        bubbleY + bubbleSize / 2,
        bubbleSize / 2 - 1,
        0,
        Math.PI * 2
      );
      ctx.stroke();

      this.compositeAnimationId = requestAnimationFrame(drawFrame);
    };

    // Start drawing
    this.isRecording = true;
    drawFrame();

    // Capture canvas as stream
    const canvasStream = canvas.captureStream(30); // 30 fps

    // Build final stream with audio
    const tracks = [...canvasStream.getVideoTracks()];
    if (audioStream) {
      tracks.push(...audioStream.getAudioTracks());
    }

    return new MediaStream(tracks);
  }

  async startCameraOnlyRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          facingMode: 'user'
        },
        audio: true
      });

      this.startMediaRecording(stream);
      this.cameraStream = stream;

      // Notify main process - this will hide main window and show recording UI
      await window.soron.recordingStarted(null);

    } catch (err) {
      console.error('Error starting camera recording:', err);
      alert('Failed to access camera: ' + err.message);
    }
  }

  startMediaRecording(stream) {
    this.recordedChunks = [];
    this.isRecording = true;
    this.isPaused = false;
    this.recordingStartTime = Date.now();

    const options = {
      mimeType: 'video/webm;codecs=vp9,opus',
      videoBitsPerSecond: 5000000, // 5 Mbps
    };

    // Fallback for browsers that don't support vp9
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options.mimeType = 'video/webm;codecs=vp8,opus';
    }

    this.mediaRecorder = new MediaRecorder(stream, options);

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.recordedChunks.push(e.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      this.saveRecording();
    };

    this.mediaRecorder.start(1000); // Collect data every second
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

  stopRecording() {
    if (!this.mediaRecorder || !this.isRecording) return;

    this.isRecording = false;
    this.mediaRecorder.stop();

    // Stop all tracks
    this.mediaRecorder.stream.getTracks().forEach(track => track.stop());

    // Stop composite animation
    if (this.compositeAnimationId) {
      cancelAnimationFrame(this.compositeAnimationId);
      this.compositeAnimationId = null;
    }

    // Stop camera stream if we were compositing
    if (this.cameraStream) {
      this.cameraStream.getTracks().forEach(track => track.stop());
      this.cameraStream = null;
    }

    // Clean up video elements
    if (this.screenVideo) {
      this.screenVideo.srcObject = null;
      this.screenVideo = null;
    }
    if (this.cameraVideo) {
      this.cameraVideo.srcObject = null;
      this.cameraVideo = null;
    }

    // Hide camera preview
    this.hideCameraPreview();
  }

  hideCameraPreview() {
    const preview = document.getElementById('camera-preview-floating');
    if (preview) {
      preview.remove();
    }
    if (this.previewStyle) {
      this.previewStyle.remove();
      this.previewStyle = null;
    }
  }

  async saveRecording() {
    const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
    const buffer = await blob.arrayBuffer();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `soron-recording-${timestamp}.webm`;

    // SIMPLIFIED: No separate camera recording
    // Camera bubble is captured directly in the screen recording

    try {
      // Step 1: Save screen recording locally
      const filePath = await window.soron.saveRecording(buffer, filename);
      console.log('Screen recording saved:', filePath);

      // Close recording UI (closes camera bubble window too)
      await window.soron.recordingStopped();

      this.showNotification('Recording saved! Processing...');

      // Step 2: Upload single video file to backend
      // Pass hasEmbeddedBubble=true if camera was enabled (bubble is IN the screen recording)
      const uploadResult = await window.soron.uploadForPersonalization(filePath, null, this.hasEmbeddedBubble);
      console.log('Upload result:', uploadResult, '(embedded bubble:', this.hasEmbeddedBubble, ')');

      // Step 3: Trigger transcription
      await this.triggerProcessing(uploadResult.video_id);

      // Step 4: Open web editor
      const editorUrl = `http://localhost:3000?video=${uploadResult.video_id}`;
      console.log('Opening editor:', editorUrl);
      window.soron.openExternal(editorUrl);

      this.showNotification('Video ready! Opening editor...');

      // Refresh recordings list
      await this.loadRecordings();

    } catch (err) {
      console.error('Error processing recording:', err);
      this.showNotification('Error: ' + err.message);
      await window.soron.recordingStopped().catch(() => {});
    }
  }

  async triggerProcessing(videoId) {
    const apiUrl = await window.soron.getStore('apiUrl') || 'http://127.0.0.1:8000';

    // Use the new parallel /process endpoint (33% faster than sequential calls)
    try {
      const processResponse = await fetch(`${apiUrl}/api/videos/${videoId}/process`, {
        method: 'POST',
      });
      if (!processResponse.ok) {
        console.warn('Processing may have failed:', await processResponse.text());
        // Fallback to sequential processing if parallel endpoint fails
        await this.triggerProcessingSequential(videoId, apiUrl);
      } else {
        const result = await processResponse.json();
        console.log(`Processing completed in ${result.processing_time_seconds}s`);
      }
    } catch (err) {
      console.warn('Parallel processing failed, trying sequential:', err);
      await this.triggerProcessingSequential(videoId, apiUrl);
    }
  }

  async triggerProcessingSequential(videoId, apiUrl) {
    // Fallback: Trigger transcription and analysis sequentially
    try {
      const transcribeResponse = await fetch(`${apiUrl}/api/videos/${videoId}/transcribe`, {
        method: 'POST',
      });
      if (!transcribeResponse.ok) {
        console.warn('Transcription may have failed:', await transcribeResponse.text());
      }
    } catch (err) {
      console.warn('Transcription request failed:', err);
    }

    try {
      const analyzeResponse = await fetch(`${apiUrl}/api/videos/${videoId}/analyze`, {
        method: 'POST',
      });
      if (!analyzeResponse.ok) {
        console.warn('Analysis may have failed:', await analyzeResponse.text());
      }
    } catch (err) {
      console.warn('Analysis request failed:', err);
    }
  }

  async loadRecordings() {
    try {
      const recordings = await window.soron.getRecordings();

      // Update recent recordings on home
      this.renderRecordings(recordings.slice(0, 4), 'recent-recordings');

      // Update all recordings
      this.renderRecordings(recordings, 'all-recordings');

    } catch (err) {
      console.error('Error loading recordings:', err);
    }
  }

  renderRecordings(recordings, containerId) {
    const container = document.getElementById(containerId);

    if (!recordings || recordings.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
          </svg>
          <h3>No recordings yet</h3>
          <p>Start recording to see your videos here</p>
        </div>
      `;
      return;
    }

    container.innerHTML = recordings.map(rec => `
      <div class="recording-card" data-path="${rec.path}" data-name="${rec.name}">
        <div class="recording-thumbnail">
          <video src="file://${rec.path}" muted></video>
          <span class="recording-duration">${this.formatFileSize(rec.size)}</span>
        </div>
        <div class="recording-info">
          <h3>${rec.name}</h3>
          <p>${this.formatDate(rec.created)}</p>
        </div>
        <div class="recording-actions">
          <button class="btn-edit" title="Edit in Web Editor">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            Edit
          </button>
          <button class="btn-play" title="Play">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </button>
        </div>
      </div>
    `).join('');

    // Add click handlers
    container.querySelectorAll('.recording-card').forEach(card => {
      // Play button - opens file directly
      const playBtn = card.querySelector('.btn-play');
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.soron.openFile(card.dataset.path);
      });

      // Edit button - uploads to backend and opens web editor
      const editBtn = card.querySelector('.btn-edit');
      editBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.openInWebEditor(card.dataset.path, card.dataset.name);
      });

      // Preview on hover
      const video = card.querySelector('video');
      card.addEventListener('mouseenter', () => {
        video.currentTime = 0;
        video.play().catch(() => {});
      });
      card.addEventListener('mouseleave', () => {
        video.pause();
        video.currentTime = 0;
      });
    });
  }

  async openInWebEditor(filePath, fileName) {
    try {
      // Show loading state
      const statusEl = document.createElement('div');
      statusEl.className = 'upload-status';
      statusEl.innerHTML = `
        <div class="upload-progress">
          <div class="spinner"></div>
          <span>Uploading to editor...</span>
        </div>
      `;
      document.body.appendChild(statusEl);

      // Upload to backend
      const result = await window.soron.uploadToBackend(filePath, fileName);

      if (result.success && result.videoId) {
        // Open web editor with video ID
        const editorUrl = `http://localhost:3000?video=${result.videoId}`;
        window.soron.openExternal(editorUrl);

        statusEl.innerHTML = `
          <div class="upload-success">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span>Opening editor...</span>
          </div>
        `;
      } else {
        throw new Error(result.error || 'Upload failed');
      }

      // Remove status after delay
      setTimeout(() => statusEl.remove(), 2000);

    } catch (err) {
      console.error('Error opening in web editor:', err);
      alert('Failed to open in editor: ' + err.message);
    }
  }

  formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  formatDate(date) {
    const d = new Date(date);
    const now = new Date();
    const diff = now - d;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' minutes ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' hours ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + ' days ago';

    return d.toLocaleDateString();
  }

  showNotification(message) {
    // Simple notification
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.textContent = message;
    notification.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: var(--accent-gradient);
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 14px;
      z-index: 9999;
      animation: slideUp 0.3s ease;
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.remove();
    }, 3000);
  }
}

// Initialize app
const app = new SoronRecorder();

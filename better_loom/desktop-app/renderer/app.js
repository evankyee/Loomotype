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

    this.init();
  }

  async init() {
    this.setupRecordButtons();
    this.setupEventListeners();
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

    try {
      const screenStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
          }
        }
      });

      // Always include mic
      let audioStream = null;
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (e) {
        console.warn('Microphone not available');
      }

      let cameraStream = null;
      if (includeCamera) {
        try {
          cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 } },
            audio: false
          });
        } catch (e) {
          console.warn('Camera not available');
        }
      }

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
    const ctx = canvas.getContext('2d');

    const bubbleSize = 400;
    const padding = 30;
    const bubbleX = padding;
    const bubbleY = canvas.height - bubbleSize - padding;

    this.compositeCanvas = canvas;
    this.screenVideo = screenVideo;
    this.cameraVideo = cameraVideo;
    this.cameraStream = cameraStream;

    const drawFrame = () => {
      if (!this.isRecording) return;

      ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);

      ctx.save();
      ctx.beginPath();
      ctx.arc(bubbleX + bubbleSize / 2, bubbleY + bubbleSize / 2, bubbleSize / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();

      const camAspect = cameraVideo.videoWidth / cameraVideo.videoHeight;
      let srcX = 0, srcY = 0, srcW = cameraVideo.videoWidth, srcH = cameraVideo.videoHeight;
      if (camAspect > 1) { srcW = cameraVideo.videoHeight; srcX = (cameraVideo.videoWidth - srcW) / 2; }
      else { srcH = cameraVideo.videoWidth; srcY = (cameraVideo.videoHeight - srcH) / 2; }

      ctx.translate(bubbleX + bubbleSize, bubbleY);
      ctx.scale(-1, 1);
      ctx.drawImage(cameraVideo, srcX, srcY, srcW, srcH, 0, 0, bubbleSize, bubbleSize);
      ctx.restore();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(bubbleX + bubbleSize / 2, bubbleY + bubbleSize / 2, bubbleSize / 2 - 1, 0, Math.PI * 2);
      ctx.stroke();

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

  startMediaRecording(stream) {
    this.recordedChunks = [];
    this.isRecording = true;
    this.isPaused = false;

    const options = { mimeType: 'video/webm;codecs=vp9,opus', videoBitsPerSecond: 5000000 };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options.mimeType = 'video/webm;codecs=vp8,opus';
    }

    this.mediaRecorder = new MediaRecorder(stream, options);
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.recordedChunks.push(e.data);
    };
    this.mediaRecorder.onstop = () => this.saveRecording();
    this.mediaRecorder.start(1000);
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
    const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
    const buffer = await blob.arrayBuffer();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `soron-recording-${timestamp}.webm`;

    try {
      const filePath = await window.soron.saveRecording(buffer, filename);
      await window.soron.recordingStopped();

      this.showNotification('Recording saved');

      const uploadResult = await window.soron.uploadForPersonalization(filePath, null, this.hasEmbeddedBubble);
      await this.triggerProcessing(uploadResult.video_id);

      const editorUrl = `http://localhost:3000?video=${uploadResult.video_id}`;
      window.soron.openExternal(editorUrl);

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
      top: -40px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(30, 30, 35, 0.9);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.9);
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 500;
      z-index: 9999;
      white-space: nowrap;
    `;

    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), 2000);
  }
}

// Initialize
const app = new SoronRecorder();

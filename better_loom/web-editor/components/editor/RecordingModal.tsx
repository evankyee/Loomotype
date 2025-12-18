'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

type RecordingMode = 'screen-camera' | 'screen-only' | 'camera-only';

interface RecordingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRecordingComplete: (file: File) => void;
}

export function RecordingModal({ isOpen, onClose, onRecordingComplete }: RecordingModalProps) {
  const [mode, setMode] = useState<RecordingMode>('screen-camera');
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const videoPreviewRef = useRef<HTMLVideoElement>(null);
  const cameraPreviewRef = useRef<HTMLVideoElement>(null);

  // Clean up streams on unmount
  useEffect(() => {
    return () => {
      if (previewStream) {
        previewStream.getTracks().forEach(track => track.stop());
      }
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [previewStream]);

  // Update preview when mode changes
  useEffect(() => {
    if (isOpen && !isRecording) {
      setupPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, isOpen]);

  const setupPreview = async () => {
    // Stop existing streams
    if (previewStream) {
      previewStream.getTracks().forEach(track => track.stop());
    }

    try {
      if (mode === 'camera-only') {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720 },
          audio: true,
        });
        setPreviewStream(stream);
        if (cameraPreviewRef.current) {
          cameraPreviewRef.current.srcObject = stream;
        }
      } else {
        // Just get camera preview for screen modes
        const cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 240 },
          audio: true,
        });
        setPreviewStream(cameraStream);
        if (cameraPreviewRef.current) {
          cameraPreviewRef.current.srcObject = cameraStream;
        }
      }
    } catch (error) {
      console.error('Failed to setup preview:', error);
    }
  };

  const startRecording = useCallback(async () => {
    // Countdown
    for (let i = 3; i > 0; i--) {
      setCountdown(i);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    setCountdown(null);

    try {
      let stream: MediaStream;

      if (mode === 'camera-only') {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1920, height: 1080 },
          audio: true,
        });
      } else {
        // Get screen stream
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: 1920, height: 1080 },
          audio: true,
        });

        if (mode === 'screen-camera') {
          // Get camera stream
          const cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 320, height: 240 },
            audio: true,
          });

          // Combine streams
          const canvas = document.createElement('canvas');
          canvas.width = 1920;
          canvas.height = 1080;
          const ctx = canvas.getContext('2d')!;

          const screenVideo = document.createElement('video');
          screenVideo.srcObject = screenStream;
          screenVideo.play();

          const cameraVideo = document.createElement('video');
          cameraVideo.srcObject = cameraStream;
          cameraVideo.play();

          // Draw combined video
          const drawFrame = () => {
            ctx.drawImage(screenVideo, 0, 0, 1920, 1080);
            // Draw camera in bottom-right corner
            const camWidth = 320;
            const camHeight = 240;
            const padding = 20;
            ctx.save();
            ctx.beginPath();
            ctx.arc(
              1920 - camWidth / 2 - padding,
              1080 - camHeight / 2 - padding,
              Math.min(camWidth, camHeight) / 2,
              0,
              Math.PI * 2
            );
            ctx.clip();
            ctx.drawImage(
              cameraVideo,
              1920 - camWidth - padding,
              1080 - camHeight - padding,
              camWidth,
              camHeight
            );
            ctx.restore();
            requestAnimationFrame(drawFrame);
          };
          drawFrame();

          const canvasStream = canvas.captureStream(30);

          // Get audio from both
          const audioContext = new AudioContext();
          const dest = audioContext.createMediaStreamDestination();

          const screenAudio = screenStream.getAudioTracks()[0];
          if (screenAudio) {
            const screenSource = audioContext.createMediaStreamSource(new MediaStream([screenAudio]));
            screenSource.connect(dest);
          }

          const cameraAudio = cameraStream.getAudioTracks()[0];
          if (cameraAudio) {
            const cameraSource = audioContext.createMediaStreamSource(new MediaStream([cameraAudio]));
            cameraSource.connect(dest);
          }

          stream = new MediaStream([
            ...canvasStream.getVideoTracks(),
            ...dest.stream.getAudioTracks(),
          ]);
        } else {
          stream = screenStream;
        }
      }

      chunksRef.current = [];

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp9',
      });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        const file = new File([blob], `recording-${Date.now()}.webm`, { type: 'video/webm' });
        onRecordingComplete(file);
        stream.getTracks().forEach(track => track.stop());
        handleClose();
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(1000); // Collect data every second

      setIsRecording(true);
      setRecordingTime(0);

      // Start timer
      timerRef.current = setInterval(() => {
        setRecordingTime(t => t + 1);
      }, 1000);

    } catch (error) {
      console.error('Failed to start recording:', error);
      alert('Failed to start recording. Please make sure you have granted camera and screen permissions.');
    }
  }, [mode, onRecordingComplete]);

  const pauseRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      if (isPaused) {
        mediaRecorderRef.current.resume();
        timerRef.current = setInterval(() => {
          setRecordingTime(t => t + 1);
        }, 1000);
      } else {
        mediaRecorderRef.current.pause();
        if (timerRef.current) {
          clearInterval(timerRef.current);
        }
      }
      setIsPaused(!isPaused);
    }
  }, [isRecording, isPaused]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      setIsRecording(false);
      setIsPaused(false);
    }
  }, [isRecording]);

  const handleClose = () => {
    if (previewStream) {
      previewStream.getTracks().forEach(track => track.stop());
      setPreviewStream(null);
    }
    if (isRecording) {
      stopRecording();
    }
    setIsRecording(false);
    setIsPaused(false);
    setRecordingTime(0);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
      {/* Countdown overlay */}
      {countdown !== null && (
        <div className="absolute inset-0 flex items-center justify-center z-50 bg-black/50">
          <div className="text-9xl font-bold text-white animate-pulse">
            {countdown}
          </div>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl w-full max-w-4xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${isRecording ? 'bg-danger recording-pulse' : 'bg-muted'}`} />
            <h2 className="text-lg font-semibold">
              {isRecording ? 'Recording' : 'Start Recording'}
            </h2>
            {isRecording && (
              <span className="font-mono text-muted">
                {formatTime(recordingTime)}
              </span>
            )}
          </div>
          <button
            onClick={handleClose}
            className="p-2 rounded-lg hover:bg-card-hover transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Preview area */}
        <div className="aspect-video bg-black relative">
          {mode === 'camera-only' ? (
            <video
              ref={cameraPreviewRef}
              autoPlay
              muted
              playsInline
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              {!isRecording && (
                <div className="text-center">
                  <svg className="w-16 h-16 mx-auto text-muted mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  <p className="text-muted">Screen preview will appear when recording starts</p>
                </div>
              )}
            </div>
          )}

          {/* Camera preview bubble (for screen modes) */}
          {mode !== 'camera-only' && (
            <div className="absolute bottom-4 right-4 w-40 h-32 rounded-2xl overflow-hidden border-2 border-white/20 shadow-xl">
              <video
                ref={cameraPreviewRef}
                autoPlay
                muted
                playsInline
                className="w-full h-full object-cover"
              />
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="p-6 space-y-4">
          {/* Mode selector (only when not recording) */}
          {!isRecording && (
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => setMode('screen-camera')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                  mode === 'screen-camera'
                    ? 'bg-primary text-white'
                    : 'bg-secondary text-muted hover:text-foreground'
                }`}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                Screen + Camera
              </button>
              <button
                onClick={() => setMode('screen-only')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                  mode === 'screen-only'
                    ? 'bg-primary text-white'
                    : 'bg-secondary text-muted hover:text-foreground'
                }`}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                Screen Only
              </button>
              <button
                onClick={() => setMode('camera-only')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                  mode === 'camera-only'
                    ? 'bg-primary text-white'
                    : 'bg-secondary text-muted hover:text-foreground'
                }`}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                Camera Only
              </button>
            </div>
          )}

          {/* Recording controls */}
          <div className="flex items-center justify-center gap-4">
            {!isRecording ? (
              <button
                onClick={startRecording}
                className="flex items-center gap-2 px-6 py-3 bg-danger text-white rounded-full font-medium hover:opacity-90 transition-opacity"
              >
                <div className="w-4 h-4 rounded-full bg-white" />
                Start Recording
              </button>
            ) : (
              <>
                <button
                  onClick={pauseRecording}
                  className={`p-4 rounded-full transition-colors ${
                    isPaused
                      ? 'bg-accent text-white'
                      : 'bg-secondary text-foreground hover:bg-card-hover'
                  }`}
                >
                  {isPaused ? (
                    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  ) : (
                    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                    </svg>
                  )}
                </button>
                <button
                  onClick={stopRecording}
                  className="flex items-center gap-2 px-6 py-3 bg-danger text-white rounded-full font-medium hover:opacity-90 transition-opacity"
                >
                  <div className="w-4 h-4 rounded bg-white" />
                  Stop Recording
                </button>
              </>
            )}
          </div>

          {/* Tips */}
          {!isRecording && (
            <div className="text-center text-sm text-muted">
              <p>Press <kbd className="px-2 py-1 bg-secondary rounded">Space</kbd> to pause/resume during recording</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

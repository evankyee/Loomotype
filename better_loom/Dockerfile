# Soron Video Personalization API
# Optimized for fast video processing with multi-threaded FFmpeg

FROM python:3.11-slim

# Install optimized FFmpeg with all codecs and multi-threading support
# Using static build for best performance (includes libx264 with threading)
RUN apt-get update && apt-get install -y \
    wget \
    xz-utils \
    libsm6 \
    libxext6 \
    libgl1 \
    && rm -rf /var/lib/apt/lists/* \
    # Download latest static FFmpeg build (optimized, all codecs)
    && wget -q https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
    && tar -xf ffmpeg-release-amd64-static.tar.xz \
    && mv ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/ \
    && mv ffmpeg-*-amd64-static/ffprobe /usr/local/bin/ \
    && rm -rf ffmpeg-* \
    # Verify installation
    && ffmpeg -version

WORKDIR /app

# Copy requirements and install Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY src/ src/

# Create necessary directories with proper permissions
RUN mkdir -p uploads output /tmp/soron && chmod -R 777 uploads output /tmp/soron

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV PORT=8080
# Optimize for multi-core processing
ENV MALLOC_ARENA_MAX=2
ENV OMP_NUM_THREADS=8

# Expose port
EXPOSE 8080

# Run with multiple workers for better concurrency
CMD ["uvicorn", "src.api.server:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "2"]

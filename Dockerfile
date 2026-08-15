FROM node:20-bookworm-slim

# Install FFmpeg, Python3, and dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp via pip for instant startup without PyInstaller extraction overhead
RUN pip3 install --no-cache-dir --break-system-packages -U yt-dlp

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "lambda/server.js"]

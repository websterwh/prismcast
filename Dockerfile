# PrismCast Docker image. Published to ghcr.io/hjdhjd/prismcast on each release.
# docker pull ghcr.io/hjdhjd/prismcast:latest
FROM lscr.io/linuxserver/xvfb:debiantrixie AS xvfb

FROM debian:trixie-slim

# VirtualGL redirects Chrome's OpenGL/EGL rendering to the real NVIDIA GPU and reads back only the final composited
# frames over plain X11 (XPutImage) into Xvfb. This is required because Xvfb has no GPU-backed X server behind it, so
# neither GLX nor native EGL-over-X11 can reach hardware through Xvfb directly (both fall back to Mesa llvmpipe).
# docker-entrypoint.sh and scripts/chrome-no-sandbox.sh wrap Chrome in "vglrun -d egl0" only when an NVIDIA GPU is detected.

# Prevent interactive prompts during package installation.
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies, Chrome dependencies, x11vnc, and noVNC.
RUN apt-get update && apt-get install -y \
    # Basic utilities.
    curl \
    wget \
    gnupg \
    ca-certificates \
    unzip \
    # Xvfb and X11 utilities (standard Xvfb installed here for deps; overridden below by custom build).
    xvfb \
    x11vnc \
    x11-xkb-utils \
    xfonts-100dpi \
    xfonts-75dpi \
    xfonts-scalable \
    x11-apps \
    xauth \
    # noVNC for web-based VNC access.
    novnc \
    # Chrome dependencies.
    libasound2t64 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgdk-pixbuf-2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    # Fonts for proper rendering.
    fonts-liberation \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-freefont-ttf \
    # Process management.
    procps \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22.x via nodesource.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Google Chrome. Chromium is not supported - PrismCast requires Google Chrome for the puppeteer-stream extension.
RUN wget -q -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get update \
    && apt-get install -y /tmp/google-chrome.deb \
    && rm /tmp/google-chrome.deb \
    && rm -rf /var/lib/apt/lists/*

# Install Intel VA-API and NVIDIA GLVND libraries for hardware-accelerated video decoding and rendering.
RUN sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y \
    libva2 \
    libva-drm2 \
    libva-glx2 \
    libgl1-mesa-dri \
    libxshmfence1 \
    mesa-va-drivers \
    mesa-vulkan-drivers \
    libvulkan1 \
    i965-va-driver \
    intel-media-va-driver \
    vainfo \
    nvidia-vaapi-driver \
    libglvnd0 \
    libgl1 \
    libglx0 \
    libegl1 \
    libgles2 \
    && rm -rf /var/lib/apt/lists/*

# VirtualGL: redirects Chrome's GL/EGL rendering to the real NVIDIA GPU (via its EGL back end against /dev/dri or the
# NVIDIA device) and delivers only the finished frames to Xvfb over plain X11, which is the one path that actually
# reaches hardware through a GPU-less X server. Installed unconditionally; it is a no-op unless invoked via vglrun.
RUN curl -fsSL -o /tmp/virtualgl.deb \
    https://github.com/VirtualGL/virtualgl/releases/download/3.1.5/virtualgl_3.1.5_amd64.deb \
    && apt-get update && apt-get install -y /tmp/virtualgl.deb \
    && rm -f /tmp/virtualgl.deb \
    && rm -rf /var/lib/apt/lists/*

# Install Bento4 mp4decrypt for DRM fragment decryption.
RUN curl -fsSL -o /tmp/bento4.zip https://www.bok.net/Bento4/binaries/Bento4-SDK-1-6-0-641.x86_64-unknown-linux.zip \
    && unzip -q /tmp/bento4.zip -d /tmp/bento4 \
    && mv /tmp/bento4/Bento4-SDK-1-6-0-641.x86_64-unknown-linux/bin/mp4decrypt /usr/local/bin/mp4decrypt \
    && chmod +x /usr/local/bin/mp4decrypt \
    && rm -rf /tmp/bento4*

# Python environment for Widevine and PlayReady DRM CDM bridge.
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    && python3 -m venv /opt/prismcast-drm-venv \
    && /opt/prismcast-drm-venv/bin/pip install --no-cache-dir pywidevine pyplayready \
    && rm -rf /var/lib/apt/lists/*

# Build and install PrismCast globally from local source.
WORKDIR /app
COPY . .
RUN (npm ci || npm install) \
    && npm run build \
    && npm pack \
    && npm install -g prismcast-*.tgz \
    && (mkdir -p /usr/lib/node_modules/prismcast/dist/drm && cp src/drm/widevine_bridge.py /usr/lib/node_modules/prismcast/dist/drm/widevine_bridge.py && chmod +x /usr/lib/node_modules/prismcast/dist/drm/widevine_bridge.py || true) \
    && (mkdir -p /usr/local/lib/node_modules/prismcast/dist/drm && cp src/drm/widevine_bridge.py /usr/local/lib/node_modules/prismcast/dist/drm/widevine_bridge.py && chmod +x /usr/local/lib/node_modules/prismcast/dist/drm/widevine_bridge.py || true) \
    && cd / \
    && rm -rf /app
# Create a Chrome wrapper script that passes --no-sandbox for container environments and enables Intel VA-API hardware video encoding.
COPY scripts/chrome-no-sandbox.sh /usr/local/bin/chrome-no-sandbox
RUN chmod +x /usr/local/bin/chrome-no-sandbox

# Copy the startup script into the container.
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create the VNC password directory. Users can mount a password file here for authenticated VNC access.
RUN mkdir -p /root/.vnc

# Overlay the LinuxServer custom Xvfb (with DRI3/DRM -vfbdevice support) over the standard Debian binary.
COPY --from=xvfb / /

# Set environment variables for the virtual display, Chrome binary, and Puppeteer.
ENV DISPLAY=:99
ENV CHROME_BIN=/usr/local/bin/chrome-no-sandbox
ENV PRISMCAST_CONTAINER=1
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV XDG_RUNTIME_DIR=/tmp/runtime-root
ENV DISABLE_ZINK=false
ENV DISABLE_DRI3=false
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=all
# Data persistence. Mount a volume at the data directory to preserve configuration, Chrome profile, and logs across container recreations:
#   docker run -v prismcast-data:/root/.prismcast ...
# Custom directories are supported via PRISMCAST_DATA_DIR, PRISMCAST_CHROME_DATA_DIR, and PRISMCAST_LOG_FILE environment variables.

# Expose the TCP ports the container serves.
# 5589 - PrismCast web UI and streaming.
# 5900 - VNC server for direct VNC client access.
# 6080 - noVNC web interface for browser-based Chrome access.
# 5004 - HDHomeRun emulation.
# HDHomeRun LAN discovery additionally binds UDP 65001. It is intentionally not EXPOSEd because the broadcast-based discovery does not traverse Docker's bridge
# NAT... clients that rely on auto-discovery (Plex, Channels DVR) need host networking for that path to work.
EXPOSE 5589 5900 6080 5004

# Health check verifies that the PrismCast web server is responding.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
    CMD wget -q --spider http://localhost:5589/health || exit 1

# Use the entrypoint script to start Xvfb, x11vnc, noVNC, and PrismCast.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

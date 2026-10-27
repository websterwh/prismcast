#!/bin/bash

# Chrome uses the last --enable-features switch. Merge Puppeteer's features with
# the container's VA-API features so neither list replaces the other.
features=VaapiVideoDecoder,VaapiVideoEncoder,AcceleratedVideoEncoder,VaapiIgnoreDriverChecks
args=()
for arg in "$@"; do
    case "$arg" in
        --enable-features=*)
            extra_features=${arg#--enable-features=}
            if [[ -n "$extra_features" ]]; then
                features+=",$extra_features"
            fi
            ;;
        *) args+=("$arg") ;;
    esac
done

# The container's Xvfb display has no window manager, so nothing can move, resize, or
# maximize the Chrome window, and without a size Chrome falls back to its default or a
# stale placement saved in the profile. When the entrypoint hands us the display size,
# pin the window to fill the virtual display so it fits noVNC and VNC clients.
# Arguments passed later still take precedence.
window=()
if [[ -n "$SCREEN_WIDTH" && -n "$SCREEN_HEIGHT" ]]; then
    window=(--window-position=0,0 "--window-size=$SCREEN_WIDTH,$SCREEN_HEIGHT")
fi
gpu_flags=()
vgl_wrapper=()
if [ "$PRISMCAST_USE_NVIDIA" = "1" ] || [ -e /dev/nvidia0 ] || command -v nvidia-smi >/dev/null 2>&1; then
    # Keep Chrome on ANGLE-over-desktop-GL (ordinary GLX calls) rather than native EGL. Xvfb's own GLX has no GPU
    # behind it and would resolve these calls to Mesa's software llvmpipe - the point of vglrun below is that it
    # intercepts these exact GLX calls via LD_PRELOAD before Xvfb ever sees them and redirects the rendering to the
    # real NVIDIA GPU through VirtualGL's EGL back end, handing only the finished frames back to Xvfb over X11.
    gpu_flags+=(--use-gl=angle --use-angle=gl)

    # egl0 is VirtualGL's EGL device index, not a Chrome flag - it selects which GPU VirtualGL's EGL back end
    # renders on, independent of (and invisible to) Chrome's own --use-gl selection above.
    vgl_wrapper=(/opt/VirtualGL/bin/vglrun -d egl0)
fi

exec "${vgl_wrapper[@]}" /usr/bin/google-chrome-stable --no-sandbox --disable-setuid-sandbox --disable-gpu-sandbox \
    "--enable-features=$features" --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy \
    "${gpu_flags[@]}" "${window[@]}" "${args[@]}"
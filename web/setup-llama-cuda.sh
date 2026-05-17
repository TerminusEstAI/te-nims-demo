#!/bin/bash
# Build llama.cpp with CUDA on severian-demo-gpu (T4 / sm_75)
# Idempotent — safe to re-run. Run with: bash setup-llama-cuda.sh
set -e
LOG=/tmp/setup-llama-cuda.log
exec > >(tee -a "$LOG") 2>&1
echo "=== $(date) start ==="

pkill -f 'llama-server' 2>/dev/null || true

# 1. Install build deps
if ! command -v nvcc >/dev/null || ! command -v cmake >/dev/null; then
  echo "Installing CUDA toolkit + cmake..."
  sudo DEBIAN_FRONTEND=noninteractive apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    nvidia-cuda-toolkit cmake build-essential git ccache
fi
# CUDA 11.5 (Ubuntu 22.04 default) is incompatible with the system GCC 11.
# Install gcc-10/g++-10 and force CMake to use them for CUDA host compilation.
if ! command -v gcc-10 >/dev/null; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y gcc-10 g++-10
fi
nvcc --version | tail -3
cmake --version | head -1

# 2. Clone llama.cpp pinned to b9198 (Gemma 4 supported)
SRC=/opt/llama.cpp-vision
if [ ! -d "$SRC/.git" ]; then
  sudo mkdir -p "$SRC"
  sudo chown -R "$USER:$USER" "$SRC"
  git clone --depth 1 --branch b9198 https://github.com/ggml-org/llama.cpp.git "$SRC"
fi
cd "$SRC"

# 3. Configure + build (CUDA, sm_75 for T4)
if [ ! -x "$SRC/build/bin/llama-server" ]; then
  rm -rf "$SRC/build"
  echo "Configuring (gcc-10 for CUDA host)..."
  cmake -B build \
    -DGGML_CUDA=ON \
    -DCMAKE_CUDA_ARCHITECTURES=75 \
    -DCMAKE_C_COMPILER=gcc-10 \
    -DCMAKE_CXX_COMPILER=g++-10 \
    -DCMAKE_CUDA_HOST_COMPILER=g++-10 \
    -DLLAMA_BUILD_SERVER=ON \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_EXAMPLES=ON
  echo "Building (slow on 4 vCPU)..."
  cmake --build build --config Release -j 4 --target llama-server
fi

ls -la "$SRC/build/bin/llama-server"
echo "=== $(date) done ==="

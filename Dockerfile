FROM ollama/ollama:latest

# Install Python + utilities used by serve.py and Piper TTS
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv curl ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps (Piper TTS, Mem0 session memory, Ollama client for Mem0)
COPY requirements.txt .
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt

# App files: web (UI + Python server), data (damage GeoJSON), imagery (MBTiles)
COPY web/             /app/web/
COPY data/            /app/data/
COPY imagery-cache/   /app/imagery-cache/
COPY Modelfile entrypoint.sh /app/
RUN chmod +x /app/entrypoint.sh

EXPOSE 8765 11434
ENTRYPOINT ["/app/entrypoint.sh"]

# ── Stage 1: build the frontend ───────────────────────────────────────────────
FROM node:20-slim AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --prefer-offline

COPY frontend/ ./
RUN npm run build

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

# demoparser2 needs a Rust/cargo toolchain at install time via maturin;
# install build deps, then clean up to keep the image small.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl build-essential \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Remove build deps after pip install to keep image lean
RUN apt-get purge -y --auto-remove build-essential curl \
    && rm -rf /root/.cargo /root/.rustup

COPY backend/ ./

# Copy built frontend so the backend can serve it as static files
COPY --from=frontend-builder /app/frontend/dist ../frontend/dist

# Data directory for SQLite DB (mount a volume here for persistence)
RUN mkdir -p /app/backend/data /tmp/cs2radar_uploads

ENV PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8000 \
    DB_PATH=/app/backend/data/demos.db \
    UPLOAD_DIR=/tmp/cs2radar_uploads

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

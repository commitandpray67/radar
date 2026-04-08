# CS2 Demo Radar

A desktop-first web application for analysing Counter-Strike 2 demo (`.dem`) files.
Visualise player positions on the official radar, scrub through rounds, and generate
positional heatmaps for any combination of players and rounds.

---

## Architecture

```
cs2-radar/
├── backend/                  # Python 3.11+ FastAPI service
│   ├── main.py               # Application entry-point
│   ├── requirements.txt
│   ├── pytest.ini
│   ├── api/
│   │   └── routes.py         # REST + SSE endpoints
│   ├── parser/
│   │   └── demo_parser.py    # demoparser2 integration → normalised schema
│   ├── analytics/
│   │   ├── coordinates.py    # World ↔ radar pixel transformation
│   │   └── heatmap.py        # 2-D density grid + Gaussian smoothing
│   ├── maps/
│   │   └── calibration.py    # Per-map pos_x/pos_y/scale/layers
│   ├── db/
│   │   └── database.py       # aiosqlite schema + CRUD
│   ├── data/                 # SQLite cache lives here (git-ignored)
│   └── tests/
│       ├── test_coordinates.py
│       ├── test_calibration.py
│       ├── test_heatmap.py
│       └── test_api.py
└── frontend/                 # React 18 + TypeScript + Vite
    ├── index.html
    ├── vite.config.ts
    ├── tsconfig.json
    ├── package.json
    ├── public/
    │   └── maps/             # Radar PNG images (1024×1024)
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── styles/globals.css
        ├── types/index.ts    # Domain types (mirrors backend schema)
        ├── store/demoStore.ts # Zustand global state
        ├── utils/
        │   ├── api.ts        # Axios wrappers for all API calls
        │   ├── coordinates.ts # Client-side coordinate transform
        │   └── playback.ts   # Tick-index + binary search helpers
        └── components/
            ├── DemoLoader/   # Drag-and-drop file picker + SSE progress
            ├── RadarViewer/  # Canvas-based radar + player markers
            ├── Playback/     # Tick slider, play/pause, speed
            ├── RoundPanel/   # Round list with metadata
            ├── HeatmapControls/ # Heatmap config + generate button
            └── Layout/       # Three-column app shell
```

### Technology choices

| Layer | Technology | Reason |
|---|---|---|
| Demo parsing | `demoparser2` (Rust) | Only reliable CS2 binary parser; handles Source 2 format |
| Backend | FastAPI + uvicorn | Async-native; SSE for parse progress; automatic OpenAPI docs |
| Cache | SQLite + aiosqlite | Zero-infrastructure; survives server restarts |
| Frontend | React 18 + Vite | Fast HMR; JSX + TypeScript type safety |
| State | Zustand | Minimal boilerplate; fine-grained subscriptions |
| Radar | HTML5 Canvas | No DOM overhead; handles 10 players × 64 tick smoothly |
| Heatmap | NumPy + SciPy gaussian_filter | Vectorised; 10 k+ points < 200 ms |
| Styling | CSS Modules | Scoped styles; no runtime overhead |

---

## Quick start

### Prerequisites

- Python 3.11+
- Node.js 18+
- pip

### 1. Install radar images

Download CS2 radar overview PNGs (1024 × 1024) and place them in
`frontend/public/maps/` with filenames matching those in
`backend/maps/calibration.py` (e.g. `de_dust2_radar.png`).

You can extract them from your CS2 installation:
```
game/csgo/resource/overviews/<mapname>_radar.png
```

Or use the community mirror at https://github.com/CS2Modding/overview-overviews
(verify checksums before use).

### 2. Backend

```bash
cd backend

# Create a virtual environment
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run the development server
python main.py
# → http://localhost:8000
# → API docs: http://localhost:8000/docs
```

### 3. Frontend

```bash
cd frontend

npm install
npm run dev
# → http://localhost:5173
```

The Vite dev server proxies `/api/*` to `http://localhost:8000` automatically.

### 4. Use the app

1. Open `http://localhost:5173`
2. Drag and drop a CS2 `.dem` file onto the screen
3. Watch parse progress in real time via SSE
4. Use the round panel on the left to jump to any round
5. Use the tick slider to scrub through time
6. Click player dots on the radar to select them
7. Switch to the **Heatmap** tab, pick rounds, and click **Generate heatmap**

---

## Running tests

```bash
cd backend
pytest
```

Tests cover:
- Coordinate transformation (world ↔ radar pixel, rotation, multi-level Z)
- Map calibration data validation
- Heatmap density computation (filtering, sampling, normalisation, grid shape)
- FastAPI route smoke tests (maps list, upload validation, 404 handling)

---

## API reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/demos/upload` | Upload `.dem` file; returns `job_id` + `demo_id` |
| `GET`  | `/api/parse-status/{job_id}` | SSE stream of parse progress |
| `GET`  | `/api/demos` | List all cached demos |
| `GET`  | `/api/demos/{id}` | Demo metadata |
| `GET`  | `/api/demos/{id}/rounds` | All round info |
| `GET`  | `/api/demos/{id}/players` | Player roster |
| `GET`  | `/api/demos/{id}/positions` | Sampled positions (filterable) |
| `GET`  | `/api/demos/{id}/events` | Game events |
| `POST` | `/api/demos/{id}/heatmap` | Generate heatmap PNG (base64) |
| `GET`  | `/api/maps` | All maps with calibration metadata |

Full interactive docs: `http://localhost:8000/docs`

---

## Coordinate transformation

Game world coordinates (X, Y, Z) are in Hammer units.
The radar image is 1024 × 1024 pixels with (0, 0) at the top-left.

```
radar_px = (world_x - pos_x) / scale
radar_py = (pos_y  - world_y) / scale   # Y-axis is inverted
```

Each map has its own `pos_x`, `pos_y`, and `scale` in
`backend/maps/calibration.py`.  Multi-level maps (Nuke, Vertigo) additionally
have Z-range thresholds that determine which radar image layer to use.

To add a new map:
1. Add an entry to `MAP_CALIBRATIONS` in `calibration.py`
2. Place the radar PNG in `frontend/public/maps/`
3. Add the same calibration parameters to the `MAP_CALIBRATIONS` dict in
   `frontend/src/components/RadarViewer/RadarViewer.tsx`

---

## Heatmap algorithm

```
Input  : player_ids[], round_numbers[], time filters
 ↓
Filter positions by player + round (vectorised NumPy boolean mask)
 ↓
Convert world (X,Y) → radar pixels (batch, no Python loop)
 ↓
np.histogram2d → 2D density grid (grid_cell_size pixels per bin)
 ↓
scipy.ndimage.gaussian_filter → Gaussian smoothing (blur_sigma in bins)
 ↓
Normalise to [0, 1]
 ↓
matplotlib colormap → RGBA array → PNG → base64 data URL
```

Tunable parameters (via the `HeatmapPayload` API body):
- `sample_every` — subsample every Nth row for speed
- `blur_sigma` — Gaussian kernel radius (larger = smoother)
- `grid_cell_size` — pixels per histogram bin (smaller = finer detail)
- `team_filter` — "CT" | "T" | null
- `layer_label` — for multi-level maps

---

## Adding map calibration values

Valve stores calibration in:
```
game/csgo/resource/overviews/<mapname>.txt
```

Key fields:
```
"pos_x"   "-2476"
"pos_y"   "3239"
"scale"   "4.400000"
```

For maps with a `verticalsections` block, extract Z thresholds from the
`AltitudeMax` / `AltitudeMin` entries in each section.

---

## Known limitations / next steps

1. **Radar images** — must be sourced from the CS2 installation; not bundled
2. **Z-coordinate filtering on multi-level maps** — per-player Z is used to
   select the correct layer but both layers are drawn on the same canvas;
   a layer toggle button is provided in HeatmapControls
3. **Bomb object position** — tracker for the bomb entity (not just events) is
   not yet implemented in the parser; bomb events (plant/defuse/explode) are
   included
4. **Grenade trajectories** — parsed but not rendered (event data is available)
5. **Performance on very long demos** — position fetching for all rounds at
   once (`GET /positions`) can be large; consider paginating or fetching
   per-round on demand in production
6. **Authentication** — no auth; designed for local / LAN use
7. **Tauri/Electron packaging** — the backend runs as a subprocess; hookup
   code for desktop packaging is not yet written

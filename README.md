# CS2 Demo Radar

CS2 Demo Radar is a desktop-first web app for inspecting Counter-Strike 2 (`.dem`) files.
It parses demos on the backend, caches normalized data in SQLite, and renders a radar replay
UI with rounds, playback, killfeed, live player info, heatmaps, and multi-round overlays.

---

## What the app does

After upload, the app parses and stores:

- Demo metadata (map, tickrate, total ticks)
- Round boundaries + winners + score progression
- Player roster and sampled player positions
- Core gameplay events (kills, bomb events)
- Grenade events (throw / detonate / expire) and **best-effort bounce trajectory points**
- Player-state events (spawn, hurt, equip/pickup/purchase derived loadout state)

From this data, the frontend provides:

- Radar playback by round and tick
- Killfeed with per-kill side-aware coloring
- Live Info player cards with HP/armor bars and loadout summary
- Heatmap generation for selected players/rounds
- Multi-round overlay replay mode

---

## Architecture

```
cs2-radar/
├── backend/
│   ├── main.py
│   ├── api/routes.py
│   ├── parser/demo_parser.py
│   ├── analytics/
│   ├── maps/calibration.py
│   ├── db/database.py
│   └── tests/
└── frontend/
    ├── public/
    │   ├── maps/
    │   └── icons/grenades/
    └── src/
        ├── store/demoStore.ts
        ├── utils/api.ts
        └── components/
```

### Stack

- **Backend:** FastAPI + aiosqlite
- **Parser:** demoparser2
- **Frontend:** React + TypeScript + Vite + Zustand
- **Rendering:** HTML canvas for radar + overlays
- **Heatmaps:** NumPy/SciPy on backend

---

## Quick start

## 1) Prerequisites

- Python 3.11+
- Node.js 18+
- `pip` / `npm`

## 2) Radar images

Place radar PNGs (1024x1024) in `frontend/public/maps/` with names like:

- `de_dust2_radar.png`
- `de_mirage_radar.png`

Map calibration values live in `backend/maps/calibration.py`.

## 3) Run backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

Backend default URL: `http://localhost:8000`
Docs: `http://localhost:8000/docs`

## 4) Run frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend URL: `http://localhost:5173`

---

## How to use

1. Upload a `.dem` file in the loader.
2. Wait for parse completion (SSE progress).
3. Select a round from the left panel.
4. Use playback controls to scrub ticks / play.
5. Switch right panel tabs:
   - **Players:** roster and selection
   - **Live Info:** HP/armor bars + loadout snapshot
6. Optional modes:
   - **Heatmap:** generate density overlay for selected players/rounds
   - **Multi-round:** replay 2+ rounds overlaid at round-relative time

> Heatmap and Multi-round are mutually exclusive by design.

---

## Live Info details

Live Info reconstructs state from parser events up to current tick:

- HP/armor from spawn + hurt + purchase/equip-derived events
- Weapons/loadout from equip/pickup/purchase events
- Team side from current round position samples (with fallback)

UI behavior:

- Top bar: player number, nickname, side badge
- Middle: separate HP and armor bars
- Bottom: pistol, primary, and inline grenades
- Dead players are greyed-out

### Grenade icons

If you want icon textures, add PNGs to:

`frontend/public/icons/grenades/`

Expected filenames:

- `hegrenade.png`
- `flashbang.png`
- `smokegrenade.png`
- `molotov.png`
- `incgrenade.png`
- `decoy.png`

If missing, text fallback labels are shown.

---

## Grenade trajectory model

Grenades are rendered using:

- throw tick
- optional bounce points (if parser event data exists)
- detonation point

During flight, the moving dot interpolates across trajectory segments.

### Important

Trajectory quality depends on demo event availability. If bounce events are absent
for a specific demo/event, rendering falls back toward simpler paths.

---

## Data cache and reparsing

Parsed demos are cached in SQLite (`backend/data/demos.db`).
When parser logic changes, old cached demos may not contain newly extracted fields.

If something looks outdated (e.g., trajectories/loadout), re-upload/re-parse the demo.

---

## API overview

Common endpoints:

- `POST /api/demos/upload`
- `GET /api/parse-status/{job_id}` (SSE)
- `GET /api/demos/{id}/rounds`
- `GET /api/demos/{id}/players`
- `GET /api/demos/{id}/positions`
- `GET /api/demos/{id}/events`
- `GET /api/demos/{id}/grenades`
- `GET /api/demos/{id}/player-state-events`
- `POST /api/demos/{id}/heatmap`
- `GET /api/maps`

---

## Running tests

Backend test suite:

```bash
cd backend
pytest -q
```

Frontend build/typecheck smoke test:

```bash
cd frontend
npm run build
```

---

## Current limitations

1. **Best-effort state reconstruction:** demo events do not always expose full inventory snapshots every tick.
2. **Grenade trajectories depend on event support:** some demos may miss bounce events.
3. **Large demos can be heavy:** loading all positions/events can be memory intensive.
4. **No auth/multi-user controls:** intended for local analysis workflows.
5. **Map/radar assets are external:** you must provide radar images manually.

---

## Troubleshooting

- **Heatmap and Multi-round conflict:** not supported simultaneously; disable one to use the other.
- **Old behavior after code changes:** remove/re-upload cached demo parse.
- **Missing grenade icons:** add PNG files to `frontend/public/icons/grenades/`.
- **Map not rendering:** verify radar image filename and map calibration entry.

---

## License / usage

Project-specific licensing is not defined in this repository.
Use radar/map assets according to Valve and source-provider terms.

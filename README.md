# CS2 Demo Radar

CS2 Demo Radar is a desktop-first web app for inspecting Counter-Strike 2 (`.dem`) files.
It parses demos on the backend, caches normalized data in SQLite, and renders a radar replay
UI with rounds, playback, killfeed, live player info, heatmaps, multi-round overlays, and
cross-demo **team analysis**.

---

## What the app does

After upload, the app parses and stores:

- Demo metadata (map, tickrate, total ticks)
- Round boundaries + winners + score progression (incl. knife-round detection)
- Player roster and sampled player positions (with view angles)
- Core gameplay events (kills, bomb events)
- Grenade events (throw / detonate / expire) and **best-effort bounce trajectory points**
- Player-state events (spawn, hurt, equip/pickup/purchase derived loadout state)

From this data, the frontend provides:

- Radar playback by round and tick (slider scrub doesn't pause, background-tab safe)
- Killfeed with per-kill side-aware coloring
- Live Info player cards with HP/armor bars and loadout summary
- Heatmap generation for selected players/rounds
- Multi-round overlay replay mode
- **Team analysis:** aggregate multiple demos of the same team on the same map for
  bigger heatmap / round samples
- **Teams organizer:** named teams that auto-group demos by map across uploads

---

## Architecture

```
cs2-radar/
├── backend/
│   ├── main.py
│   ├── api/routes.py
│   ├── parser/demo_parser.py
│   ├── analytics/
│   │   ├── heatmap.py
│   │   └── team_detection.py
│   ├── maps/calibration.py
│   ├── db/database.py
│   └── tests/
└── frontend/
    ├── public/
    │   ├── maps/
    │   └── icons/grenades/
    └── src/
        ├── store/demoStore.ts
        ├── utils/{api.ts, demoLoading.ts, playback.ts}
        └── components/
            ├── DemoLoader/    # Single / Team analysis / Teams tabs
            ├── DemoLibrary/   # Cached demos w/ bulk delete
            ├── RadarViewer/
            ├── RoundPanel/    # Per-demo and cross-demo round list
            ├── HeatmapControls/
            ├── MultiRoundControls/
            ├── Playback/
            └── PlayerInfoPanel/
```

### Stack

- **Backend:** FastAPI + aiosqlite
- **Parser:** demoparser2
- **Frontend:** React + TypeScript + Vite + Zustand
- **Rendering:** HTML canvas for radar + overlays
- **Heatmaps:** NumPy/SciPy on backend

---

## Quick start

### 1) Prerequisites

- Python 3.11+
- Node.js 18+
- `pip` / `npm`

### 2) Radar images

Place radar PNGs (1024x1024) in `frontend/public/maps/` with names like:

- `de_dust2_radar.png`
- `de_mirage_radar.png`

Map calibration values live in `backend/maps/calibration.py`.

### 3) One-shot launcher (Windows)

```cmd
start.bat
```

Runs both backend and frontend in hidden background processes and opens a single
control window. Logs are written to `backend/logs/backend.log` and
`frontend/logs/frontend.log`. Press any key in the control window to stop both
processes (kills ports 8000 and 5173).

### 4) Manual run — backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

Backend default URL: `http://localhost:8000`
Docs: `http://localhost:8000/docs`

### 5) Manual run — frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend URL: `http://localhost:5173`

---

## How to use

The loader has **three tabs**:

### Single demo

1. Drag & drop a `.dem` file, or pick one from the cached library.
2. Wait for parse completion (SSE progress).
3. Select a round from the left panel.
4. Use playback controls to scrub ticks / play.
5. Switch right panel tabs:
   - **Players:** roster and selection
   - **Live Info:** HP/armor bars + loadout snapshot
6. Left-sidebar modes:
   - **Rounds:** jump-to-round list
   - **Heatmap:** generate density overlay for selected players/rounds
   - **Multi-round:** replay 2+ rounds overlaid at round-relative time

> Heatmap and Multi-round are mutually exclusive by design.

### Team analysis

Upload (or pick) **≥2 demos of the same team on the same map**. The backend
auto-detects the shared roster (≥4 overlap, 1 substitution tolerated) and the
side each demo was played on. Name the session and create it — the round panel
then shows rounds grouped by match (M1, M2, …) and the heatmap aggregates
positions across all selected demos. Clicking a round from a different match
transparently swaps the active demo.

Saved sessions appear under **"Load saved session"** and can be bulk-deleted.

### Teams (cross-map organizer)

Create a named team (e.g. "NaVi"). Add demos from the library; the system
auto-groups them by map. Each map group shows a list of matches and an
**Open** button that creates and loads a team analysis session for those
demos. Individual matches can be removed from a team without deleting them
from the cache.

---

## Library management

Both the single-demo library and the saved team-session list support
**bulk delete**: tick the "All" checkbox or individual rows, then hit
"Delete (N)" to clear the selection in one go. Deleting a demo also cleans
up any team references to it.

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
The cache also stores team sessions and team-organizer associations.

When parser logic changes, `PARSER_VERSION` is bumped and old caches are
automatically re-parsed on next upload. If something still looks outdated
(e.g., trajectories/loadout), re-upload via the loader to force a re-parse.

---

## API overview

### Demos
- `POST /api/demos/upload`
- `GET /api/parse-status/{job_id}` (SSE)
- `GET /api/demos` — list cached
- `DELETE /api/demos/{id}`
- `GET /api/demos/{id}/rounds`
- `GET /api/demos/{id}/players`
- `GET /api/demos/{id}/positions`
- `GET /api/demos/{id}/events`
- `GET /api/demos/{id}/grenades`
- `GET /api/demos/{id}/player-state-events`
- `POST /api/demos/{id}/heatmap`
- `GET /api/maps`

### Team sessions (single-map multi-demo)
- `POST /api/team-sessions/validate` — detect shared roster + sides
- `POST /api/team-sessions` — create persisted session
- `GET /api/team-sessions` — list
- `GET /api/team-sessions/{id}` — full detail (demos + rounds + roster)
- `DELETE /api/team-sessions/{id}`
- `POST /api/team-sessions/{id}/heatmap` — cross-demo aggregated heatmap

### Teams (cross-map organizer)
- `POST /api/teams` — create
- `GET /api/teams` — list with demo counts
- `GET /api/teams/{id}` — demos grouped by map
- `DELETE /api/teams/{id}`
- `POST /api/teams/{id}/demos` — add demo(s)
- `DELETE /api/teams/{id}/demos/{demo_id}` — remove one demo

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
6. **Team detection requires roster overlap:** ≥4 shared players on the same side across ≥2 demos.

---

## Troubleshooting

- **Heatmap and Multi-round conflict:** not supported simultaneously; disable one to use the other.
- **Old behavior after code changes:** re-upload the demo to force a re-parse (parser version bump auto-handles this in most cases).
- **Team session won't validate:** ensure ≥2 demos, same map, ≥4 shared players on the same starting side.
- **Missing grenade icons:** add PNG files to `frontend/public/icons/grenades/`.
- **Map not rendering:** verify radar image filename and map calibration entry.
- **start.bat ports already in use:** kill processes on 8000 / 5173, or check logs in `backend/logs/` and `frontend/logs/`.

---

## License / usage

Project-specific licensing is not defined in this repository.
Use radar/map assets according to Valve and source-provider terms.

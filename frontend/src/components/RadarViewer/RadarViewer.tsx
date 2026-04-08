/**
 * RadarViewer — the central canvas-based map component.
 *
 * Renders:
 *  1. The map radar image as the background
 *  2. Player position markers for the current tick
 *  3. Player movement trails (last N ticks)
 *  4. Heatmap overlay image (when in heatmap mode)
 *  5. Event markers (deaths, bomb plant/defuse)
 *
 * All drawing happens on an HTML5 Canvas for performance.
 * The canvas is sized to fill its container and re-renders on:
 *  - tick change (playback)
 *  - position data change (round switch)
 *  - toggle changes (dead players, trails, heatmap)
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAppStore } from '../../store/demoStore';
import type { TickSnapshot } from '../../types';
import { TEAM_COLORS } from '../../types';
import {
  worldToCanvas,
  type CalibrationParams,
} from '../../utils/coordinates';
import {
  getSnapshotAtTick,
  nearestTick,
} from '../../utils/playback';
import styles from './RadarViewer.module.css';

// ---------------------------------------------------------------------------
// Hard-coded calibration values that the frontend knows about.
// In production, fetch from /api/maps and store in the Zustand store.
// These mirror backend/maps/calibration.py.
// ---------------------------------------------------------------------------
const MAP_CALIBRATIONS: Record<string, CalibrationParams> = {
  de_dust2:   { pos_x: -2476, pos_y:  3239, scale: 4.4, rotate: 0 },
  de_mirage:  { pos_x: -3230, pos_y:  1713, scale: 5.0, rotate: 0 },
  de_inferno: { pos_x: -2087, pos_y:  3870, scale: 4.9, rotate: 0 },
  de_cache:   { pos_x: -2000, pos_y:  3250, scale: 5.5, rotate: 0 },
  de_overpass:{ pos_x: -4831, pos_y:  1781, scale: 5.2, rotate: 0 },
  de_ancient: { pos_x: -2953, pos_y:  2164, scale: 5.0, rotate: 0 },
  de_anubis:  { pos_x: -2796, pos_y:  3328, scale: 5.22,rotate: 0 },
  de_vertigo: { pos_x: -3168, pos_y:  1762, scale: 4.0, rotate: 0 },
  de_nuke:    { pos_x: -3453, pos_y:  2887, scale: 7.0, rotate: 0 },
  de_train:   { pos_x: -2477, pos_y:  2392, scale: 4.7, rotate: 0 },
  de_office:  { pos_x: -1838, pos_y:  1858, scale: 4.1, rotate: 0 },
  cs_italy:   { pos_x: -2647, pos_y:  2592, scale: 4.6, rotate: 0 },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MARKER_RADIUS = 7;         // player dot radius in canvas pixels
const FONT_SIZE = 10;            // label font size
const TRAIL_ALPHA_MAX = 0.55;    // opacity of the most recent trail point
const DEAD_ALPHA = 0.35;         // opacity of dead player markers

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

function drawPlayerMarker(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  color: string,
  label: string,
  alpha: number,
  isAlive: boolean,
  isSelected: boolean,
  radius = MARKER_RADIUS,
): void {
  ctx.save();
  ctx.globalAlpha = isAlive ? alpha : alpha * DEAD_ALPHA;

  // Glow ring for selected players
  if (isSelected) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 4, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Main circle
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  // Dead cross
  if (!isAlive) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5;
    const d = radius * 0.6;
    ctx.beginPath();
    ctx.moveTo(cx - d, cy - d);
    ctx.lineTo(cx + d, cy + d);
    ctx.moveTo(cx + d, cy - d);
    ctx.lineTo(cx - d, cy + d);
    ctx.stroke();
  }

  // Label
  ctx.globalAlpha = isAlive ? 1 : DEAD_ALPHA;
  ctx.font = `bold ${FONT_SIZE}px 'JetBrains Mono', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label.slice(0, 3).toUpperCase(), cx, cy + 0.5);

  ctx.restore();
}

function drawTrail(
  ctx: CanvasRenderingContext2D,
  points: Array<{ cx: number; cy: number }>,
  color: string,
): void {
  if (points.length < 2) return;
  ctx.save();
  for (let i = 1; i < points.length; i++) {
    const alpha = (i / points.length) * TRAIL_ALPHA_MAX;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(points[i - 1].cx, points[i - 1].cy);
    ctx.lineTo(points[i].cx, points[i].cy);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const RadarViewer: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const radarImgRef = useRef<HTMLImageElement | null>(null);
  const [canvasSize, setCanvasSize] = useState(600);

  // Store selectors
  const demo = useAppStore((s) => s.demo);
  const players = useAppStore((s) => s.players);
  const currentTick = useAppStore((s) => s.currentTick);
  const tickIndex = useAppStore((s) => s.tickIndex);
  const sortedTicks = useAppStore((s) => s.sortedTicks);
  const showDeadPlayers = useAppStore((s) => s.showDeadPlayers);
  const showTrails = useAppStore((s) => s.showTrails);
  const trailLengthTicks = useAppStore((s) => s.trailLengthTicks);
  const selectedPlayerIds = useAppStore((s) => s.selectedPlayerIds);
  const isHeatmapMode = useAppStore((s) => s.isHeatmapMode);
  const heatmapResult = useAppStore((s) => s.heatmapResult);
  const heatmapLoading = useAppStore((s) => s.heatmapLoading);

  // ---------------------------------------------------------------------------
  // Calibration for the current map
  // ---------------------------------------------------------------------------
  const calibration = useMemo<CalibrationParams | null>(() => {
    if (!demo) return null;
    return MAP_CALIBRATIONS[demo.map_name] ?? null;
  }, [demo]);

  // ---------------------------------------------------------------------------
  // Load radar background image
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!demo) return;
    const img = new Image();
    img.src = `/maps/${demo.map_name}_radar.png`;
    img.onload = () => {
      radarImgRef.current = img;
      drawFrame();
    };
    img.onerror = () => {
      // Fallback: use placeholder
      radarImgRef.current = null;
      drawFrame();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo?.map_name]);

  // ---------------------------------------------------------------------------
  // Heatmap overlay image (preloaded)
  // ---------------------------------------------------------------------------
  const heatmapImgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!heatmapResult) {
      heatmapImgRef.current = null;
      drawFrame();
      return;
    }
    const img = new Image();
    img.src = heatmapResult.image;
    img.onload = () => {
      heatmapImgRef.current = img;
      drawFrame();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heatmapResult]);

  // ---------------------------------------------------------------------------
  // Resize observer — keep canvas square and filling the container
  // ---------------------------------------------------------------------------
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const size = Math.min(el.clientWidth, el.clientHeight);
      setCanvasSize(size > 0 ? size : 600);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---------------------------------------------------------------------------
  // Player name abbreviation helper
  // ---------------------------------------------------------------------------
  const playerLabel = useCallback(
    (playerId: number): string => {
      const p = players.find((pl) => pl.player_id === playerId);
      return p ? p.name.slice(0, 3).toUpperCase() : '???';
    },
    [players],
  );

  // ---------------------------------------------------------------------------
  // Trail positions: collect the last N sorted ticks for each player
  // ---------------------------------------------------------------------------
  const trailSnapshots = useMemo(() => {
    if (!showTrails || !sortedTicks.length) return [];
    const idx = nearestTick(currentTick, sortedTicks);
    if (idx === undefined) return [];
    const cursor = sortedTicks.indexOf(idx);
    // Take the previous trailLengthTicks ticks worth of snapshots
    const approxSteps = Math.ceil(trailLengthTicks / 8); // 8 = sample_rate
    const start = Math.max(0, cursor - approxSteps);
    return sortedTicks.slice(start, cursor + 1).map((t) => tickIndex.get(t)!).filter(Boolean);
  }, [showTrails, sortedTicks, currentTick, trailLengthTicks, tickIndex]);

  // ---------------------------------------------------------------------------
  // Current snapshot
  // ---------------------------------------------------------------------------
  const snapshot = useMemo<TickSnapshot | undefined>(
    () => getSnapshotAtTick(currentTick, tickIndex, sortedTicks),
    [currentTick, tickIndex, sortedTicks],
  );

  // ---------------------------------------------------------------------------
  // Main draw function
  // ---------------------------------------------------------------------------
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear
    ctx.clearRect(0, 0, canvasSize, canvasSize);

    // --- Background radar image ---
    if (radarImgRef.current) {
      ctx.drawImage(radarImgRef.current, 0, 0, canvasSize, canvasSize);
    } else {
      // Placeholder grid
      ctx.fillStyle = '#1a2332';
      ctx.fillRect(0, 0, canvasSize, canvasSize);
      ctx.strokeStyle = '#2a3a52';
      ctx.lineWidth = 1;
      const step = canvasSize / 8;
      for (let i = 0; i <= 8; i++) {
        ctx.beginPath();
        ctx.moveTo(i * step, 0);
        ctx.lineTo(i * step, canvasSize);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i * step);
        ctx.lineTo(canvasSize, i * step);
        ctx.stroke();
      }
      ctx.fillStyle = '#4a5a6a';
      ctx.font = '14px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        demo ? `${demo.map_name} — radar image not found` : 'No demo loaded',
        canvasSize / 2,
        canvasSize / 2,
      );
    }

    if (!calibration) return;

    // --- Heatmap overlay ---
    if (isHeatmapMode && heatmapImgRef.current) {
      ctx.save();
      ctx.globalAlpha = 0.75;
      ctx.drawImage(heatmapImgRef.current, 0, 0, canvasSize, canvasSize);
      ctx.restore();
      return; // In heatmap mode, don't draw individual players
    }

    if (!snapshot) return;

    // --- Trails ---
    if (showTrails && trailSnapshots.length > 1) {
      // Build per-player trail arrays
      const playerTrails = new Map<number, Array<{ cx: number; cy: number }>>();
      for (const snap of trailSnapshots) {
        for (const [pid, pos] of snap.entries()) {
          if (!playerTrails.has(pid)) playerTrails.set(pid, []);
          const { cx, cy } = worldToCanvas(pos.x, pos.y, calibration, canvasSize);
          playerTrails.get(pid)!.push({ cx, cy });
        }
      }
      for (const [pid, pts] of playerTrails.entries()) {
        const pos = snapshot.get(pid);
        const color = pos?.team_num === 3 ? TEAM_COLORS.CT : TEAM_COLORS.T;
        drawTrail(ctx, pts, color);
      }
    }

    // --- Player markers ---
    for (const [pid, pos] of snapshot.entries()) {
      const alive = pos.is_alive === 1 || pos.is_alive === (true as unknown as number);
      if (!showDeadPlayers && !alive) continue;

      // Filter: if players are selected, show only them (plus all in radar mode)
      const isSelected = selectedPlayerIds.has(pid);
      const color = pos.team_num === 3 ? TEAM_COLORS.CT : TEAM_COLORS.T;
      const { cx, cy } = worldToCanvas(pos.x, pos.y, calibration, canvasSize);
      const label = playerLabel(pid);

      drawPlayerMarker(ctx, cx, cy, color, label, 1, alive, isSelected);
    }
  }, [
    canvasSize,
    calibration,
    snapshot,
    showDeadPlayers,
    showTrails,
    trailSnapshots,
    selectedPlayerIds,
    playerLabel,
    isHeatmapMode,
    demo,
  ]);

  // Re-draw whenever anything relevant changes
  useEffect(() => {
    drawFrame();
  }, [drawFrame]);

  // ---------------------------------------------------------------------------
  // Click handler — select/deselect a player by clicking their marker
  // ---------------------------------------------------------------------------
  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!snapshot || !calibration) return;
      const rect = canvasRef.current!.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      const togglePlayer = useAppStore.getState().togglePlayerSelection;

      for (const [pid, pos] of snapshot.entries()) {
        const { cx, cy } = worldToCanvas(pos.x, pos.y, calibration, canvasSize);
        const dist = Math.hypot(clickX - cx, clickY - cy);
        if (dist < MARKER_RADIUS + 4) {
          togglePlayer(pid);
          break;
        }
      }
    },
    [snapshot, calibration, canvasSize],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div ref={containerRef} className={styles.container}>
      <canvas
        ref={canvasRef}
        width={canvasSize}
        height={canvasSize}
        className={styles.canvas}
        onClick={handleCanvasClick}
        title="Click a player marker to select/deselect"
      />
      {heatmapLoading && (
        <div className={styles.loadingOverlay}>
          <span>Generating heatmap…</span>
        </div>
      )}
      {!demo && (
        <div className={styles.emptyState}>
          <p>Load a demo to begin</p>
        </div>
      )}
    </div>
  );
};

export default RadarViewer;

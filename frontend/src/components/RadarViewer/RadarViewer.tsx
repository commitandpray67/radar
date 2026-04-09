/**
 * RadarViewer — canvas-based map renderer.
 *
 * Renders:
 *  1. Radar background image
 *  2. Player position markers (single-round mode)
 *  3. Movement trails
 *  4. Grenade trajectories + detonation effects
 *  5. Heatmap overlay (heatmap mode)
 *  6. Multi-round overlay (all selected rounds simultaneously)
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent as ReactWheelEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

// Clamp helper
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
import { useAppStore } from '../../store/demoStore';
import type { GrenadeEvent, TickSnapshot } from '../../types';
import { TEAM_COLORS } from '../../types';
import Killfeed from '../Killfeed/Killfeed';
import {
  worldToCanvas,
  type CalibrationParams,
} from '../../utils/coordinates';
import {
  getSnapshotAtTick,
  getSortedTicks,
  nearestTick,
  type TickIndex,
} from '../../utils/playback';
import styles from './RadarViewer.module.css';

// ---------------------------------------------------------------------------
// Map calibrations (mirrors backend calibration.py)
// ---------------------------------------------------------------------------
const MAP_CALIBRATIONS: Record<string, CalibrationParams> = {
  de_dust2:    { pos_x: -2476, pos_y:  3239, scale: 4.4, rotate: 0 },
  de_mirage:   { pos_x: -3230, pos_y:  1713, scale: 5.0, rotate: 0 },
  de_inferno:  { pos_x: -2087, pos_y:  3870, scale: 4.9, rotate: 0 },
  de_cache:    { pos_x: -2000, pos_y:  3250, scale: 5.5, rotate: 0 },
  de_overpass: { pos_x: -4831, pos_y:  1781, scale: 5.2, rotate: 0 },
  de_ancient:  { pos_x: -2953, pos_y:  2164, scale: 5.0, rotate: 0 },
  de_anubis:   { pos_x: -2796, pos_y:  3328, scale: 5.22, rotate: 0 },
  de_vertigo:  { pos_x: -3168, pos_y:  1762, scale: 4.0, rotate: 0 },
  de_nuke:     { pos_x: -3453, pos_y:  2887, scale: 7.0, rotate: 0 },
  de_train:    { pos_x: -2477, pos_y:  2392, scale: 4.7, rotate: 0 },
  de_office:   { pos_x: -1838, pos_y:  1858, scale: 4.1, rotate: 0 },
  cs_italy:    { pos_x: -2647, pos_y:  2592, scale: 4.6, rotate: 0 },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MARKER_RADIUS   = 7;
const FONT_SIZE       = 10;
const TRAIL_ALPHA_MAX = 0.55;
const DEAD_ALPHA      = 0.35;

// Grenade effect radius on the radar (canvas pixels) — approximations
const SMOKE_RADIUS_PX    = 40;
const MOLOTOV_RADIUS_PX  = 28;
const HE_RADIUS_PX       = 18;
const FLASH_RADIUS_PX    = 14;

// Multi-round overlay dot colour (neutral, same for all teams / rounds)
const MULTI_DOT_COLOR = '#c8d8e8';

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
  yaw?: number,
): void {
  ctx.save();
  ctx.globalAlpha = isAlive ? alpha : alpha * DEAD_ALPHA;

  // Direction wedge (yaw): CS2 yaw 0=East, positive CCW (toward North=+Y world).
  // Canvas Y is flipped (+Y = South on screen), so negate to convert to canvas angle.
  if (isAlive && yaw != null) {
    const angle = -(yaw * Math.PI) / 180;
    const wedgeLen = radius * 2.2;
    const wedgeHalf = Math.PI / 6;  // ±30° spread
    ctx.globalAlpha = (isAlive ? alpha : alpha * DEAD_ALPHA) * 0.7;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, wedgeLen, angle - wedgeHalf, angle + wedgeHalf);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = isAlive ? alpha : alpha * DEAD_ALPHA;
  }

  if (isSelected) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 4, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  if (!isAlive) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5;
    const d = radius * 0.6;
    ctx.beginPath();
    ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d);
    ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx - d, cy + d);
    ctx.stroke();
  }

  ctx.globalAlpha = isAlive ? 1 : DEAD_ALPHA;
  ctx.font = `bold ${FONT_SIZE}px 'JetBrains Mono', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, cx, cy + 0.5);
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

function drawGrenade(
  ctx: CanvasRenderingContext2D,
  g: GrenadeEvent,
  currentTick: number,
  throwCx: number,
  throwCy: number,
  detonateCx: number,
  detonateCy: number,
  canvasSize: number,
  trajectoryPoints: Array<{ tick: number; cx: number; cy: number }> = [],
): void {
  const { throw_tick, detonate_tick, expire_tick, grenade_type } = g;
  const inFlight   = detonate_tick !== null && currentTick >= throw_tick && currentTick < detonate_tick;
  const detonated  = detonate_tick !== null && currentTick >= detonate_tick;
  const expired    = expire_tick !== null && currentTick >= expire_tick;

  ctx.save();

  if (inFlight && detonate_tick !== null) {
    const path = [
      { tick: throw_tick, cx: throwCx, cy: throwCy },
      ...trajectoryPoints.filter((p) => p.tick > throw_tick && p.tick < detonate_tick),
      { tick: detonate_tick, cx: detonateCx, cy: detonateCy },
    ].sort((a, b) => a.tick - b.tick);

    let gx = throwCx;
    let gy = throwCy;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      if (currentTick <= b.tick) {
        const segTicks = Math.max(1, b.tick - a.tick);
        const t = Math.max(0, Math.min(1, (currentTick - a.tick) / segTicks));
        gx = a.cx + (b.cx - a.cx) * t;
        gy = a.cy + (b.cy - a.cy) * t;
        break;
      }
      gx = b.cx;
      gy = b.cy;
    }

    // Dashed trajectory line
    ctx.setLineDash([3, 4]);
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(path[0].cx, path[0].cy);
    for (let i = 1; i < path.length; i++) {
      ctx.lineTo(path[i].cx, path[i].cy);
    }
    ctx.strokeStyle = grenadeLineColor(grenade_type);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);

    // Moving dot
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(gx, gy, 4, 0, Math.PI * 2);
    ctx.fillStyle = grenadeLineColor(grenade_type);
    ctx.fill();
  }

  if (detonated && !expired) {
    // Draw effect at detonation position
    const age = currentTick - detonate_tick!;
    const maxAge = expire_tick ? expire_tick - detonate_tick! : 64;
    const fadeRatio = 1 - Math.min(1, age / maxAge);

    switch (grenade_type) {
      case 'smoke': {
        // Expanding grey circle that settles
        const growTicks = 96;  // ~1.5 s expansion
        const expandRatio = Math.min(1, age / growTicks);
        const r = SMOKE_RADIUS_PX * expandRatio * (canvasSize / 1024);
        ctx.globalAlpha = 0.55 * fadeRatio + 0.05;
        ctx.beginPath();
        ctx.arc(detonateCx, detonateCy, r, 0, Math.PI * 2);
        ctx.fillStyle = '#a0b0b8';
        ctx.fill();
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = '#d0e0e8';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        break;
      }
      case 'molotov':
      case 'incendiary': {
        const r = MOLOTOV_RADIUS_PX * (canvasSize / 1024);
        ctx.globalAlpha = 0.5 * fadeRatio + 0.1;
        ctx.beginPath();
        ctx.arc(detonateCx, detonateCy, r, 0, Math.PI * 2);
        ctx.fillStyle = grenade_type === 'molotov' ? '#e05020' : '#e07020';
        ctx.fill();
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = '#ffaa44';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        break;
      }
      case 'he': {
        const r = HE_RADIUS_PX * (1 + age / 32) * (canvasSize / 1024);
        ctx.globalAlpha = 0.7 * fadeRatio;
        ctx.beginPath();
        ctx.arc(detonateCx, detonateCy, r, 0, Math.PI * 2);
        ctx.fillStyle = '#ffdd44';
        ctx.fill();
        break;
      }
      case 'flash': {
        const r = FLASH_RADIUS_PX * (1 + age / 24) * (canvasSize / 1024);
        ctx.globalAlpha = 0.65 * fadeRatio;
        ctx.beginPath();
        ctx.arc(detonateCx, detonateCy, r, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        break;
      }
      case 'decoy': {
        const r = 8 * (canvasSize / 1024);
        ctx.globalAlpha = 0.5 * fadeRatio;
        ctx.beginPath();
        ctx.arc(detonateCx, detonateCy, r, 0, Math.PI * 2);
        ctx.fillStyle = '#a0a0a0';
        ctx.fill();
        break;
      }
    }
  }

  ctx.restore();
}

function grenadeLineColor(type: string): string {
  switch (type) {
    case 'smoke':     return '#b0c8d8';
    case 'he':        return '#ffd040';
    case 'flash':     return '#e8e8ff';
    case 'molotov':
    case 'incendiary': return '#ff6020';
    case 'decoy':     return '#a0a0c0';
    default:          return '#cccccc';
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const RadarViewer: React.FC = () => {
  const canvasRef       = useRef<HTMLCanvasElement>(null);
  const containerRef    = useRef<HTMLDivElement>(null);
  const radarImgRef     = useRef<HTMLImageElement | null>(null);
  const [canvasSize, setCanvasSize] = useState(600);

  // Zoom / pan state
  const [zoom, setZoom]   = useState(1);
  const [panX, setPanX]   = useState(0);
  const [panY, setPanY]   = useState(0);
  const isDragging        = useRef(false);
  const dragStart         = useRef({ x: 0, y: 0, px: 0, py: 0 });

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 6;

  // Store selectors
  const demo               = useAppStore((s) => s.demo);
  const players            = useAppStore((s) => s.players);
  const currentTick        = useAppStore((s) => s.currentTick);
  const tickIndex          = useAppStore((s) => s.tickIndex);
  const sortedTicks        = useAppStore((s) => s.sortedTicks);
  const showDeadPlayers    = useAppStore((s) => s.showDeadPlayers);
  const showTrails         = useAppStore((s) => s.showTrails);
  const trailLengthTicks   = useAppStore((s) => s.trailLengthTicks);
  const showGrenades       = useAppStore((s) => s.showGrenades);
  const showYaw            = useAppStore((s) => s.showYaw);
  const selectedPlayerIds  = useAppStore((s) => s.selectedPlayerIds);
  const isHeatmapMode      = useAppStore((s) => s.isHeatmapMode);
  const heatmapResult      = useAppStore((s) => s.heatmapResult);
  const heatmapLoading     = useAppStore((s) => s.heatmapLoading);
  const grenades           = useAppStore((s) => s.grenades);
  const activeRound        = useAppStore((s) => s.activeRound);
  const positions          = useAppStore((s) => s.positions);

  // Multi-round mode
  const isMultiRoundMode        = useAppStore((s) => s.isMultiRoundMode);
  const multiRoundSelectedRounds = useAppStore((s) => s.multiRoundSelectedRounds);
  const multiRoundSelectedPlayers = useAppStore((s) => s.multiRoundSelectedPlayers);
  const multiRoundRelativeTick   = useAppStore((s) => s.multiRoundRelativeTick);
  const rounds                   = useAppStore((s) => s.rounds);

  // ---------------------------------------------------------------------------
  // Calibration
  // ---------------------------------------------------------------------------
  const calibration = useMemo<CalibrationParams | null>(() => {
    if (!demo) return null;
    return MAP_CALIBRATIONS[demo.map_name] ?? null;
  }, [demo]);

  // ---------------------------------------------------------------------------
  // Load radar image
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!demo) return;
    const img = new Image();
    img.src = `/maps/${demo.map_name}_radar.png`;
    img.onload = () => { radarImgRef.current = img; drawFrame(); };
    img.onerror = () => { radarImgRef.current = null; drawFrame(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo?.map_name]);

  // ---------------------------------------------------------------------------
  // Heatmap overlay
  // ---------------------------------------------------------------------------
  const heatmapImgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!heatmapResult) { heatmapImgRef.current = null; drawFrame(); return; }
    const img = new Image();
    img.src = heatmapResult.image;
    img.onload = () => { heatmapImgRef.current = img; drawFrame(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heatmapResult]);

  // ---------------------------------------------------------------------------
  // Resize observer
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
  // Zoom / pan handlers
  // ---------------------------------------------------------------------------
  const handleWheel = useCallback((e: ReactWheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZoom((prev) => {
      const next = clamp(prev * factor, MIN_ZOOM, MAX_ZOOM);
      // Zoom toward cursor position
      const rect = canvasRef.current!.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      setPanX((px) => mouseX - (mouseX - px) * (next / prev));
      setPanY((py) => mouseY - (mouseY - py) * (next / prev));
      return next;
    });
  }, []);

  const handleMouseDown = useCallback((e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 1 && !(e.button === 0 && e.altKey)) return; // middle or alt+left
    e.preventDefault();
    isDragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, px: panX, py: panY };
  }, [panX, panY]);

  const handleMouseMove = useCallback((e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!isDragging.current) return;
    setPanX(dragStart.current.px + e.clientX - dragStart.current.x);
    setPanY(dragStart.current.py + e.clientY - dragStart.current.y);
  }, []);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  const resetView = useCallback(() => {
    setZoom(1);
    setPanX(0);
    setPanY(0);
  }, []);

  // Clamp pan so we can't drag beyond the scaled canvas
  useEffect(() => {
    const maxPan = canvasSize * (zoom - 1);
    setPanX((px) => clamp(px, -maxPan, 0));
    setPanY((py) => clamp(py, -maxPan, 0));
  }, [zoom, canvasSize]);

  // ---------------------------------------------------------------------------
  // Per-round index for multi-round mode (O(n) one pass)
  // ---------------------------------------------------------------------------
  const perRoundData = useMemo<Map<number, { tickIndex: TickIndex; sortedTicks: number[] }> | null>(() => {
    if (!isMultiRoundMode || multiRoundSelectedRounds.length === 0) return null;
    const selectedSet = new Set(multiRoundSelectedRounds);
    const roundIndexes = new Map<number, TickIndex>();

    for (const pos of positions) {
      if (!selectedSet.has(pos.round_number)) continue;
      // Player filter: if selectedPlayers is non-empty, only include those players
      if (multiRoundSelectedPlayers.size > 0 && !multiRoundSelectedPlayers.has(pos.player_id)) continue;
      if (!roundIndexes.has(pos.round_number)) roundIndexes.set(pos.round_number, new Map());
      const idx = roundIndexes.get(pos.round_number)!;
      let snap = idx.get(pos.tick);
      if (!snap) { snap = new Map(); idx.set(pos.tick, snap); }
      snap.set(pos.player_id, pos);
    }

    const result = new Map<number, { tickIndex: TickIndex; sortedTicks: number[] }>();
    for (const [rn, idx] of roundIndexes.entries()) {
      result.set(rn, { tickIndex: idx, sortedTicks: getSortedTicks(idx) });
    }
    return result;
  }, [isMultiRoundMode, multiRoundSelectedRounds, multiRoundSelectedPlayers, positions]);

  // ---------------------------------------------------------------------------
  // Player label (number 1-10)
  // ---------------------------------------------------------------------------
  const playerLabel = useCallback(
    (playerId: number): string => {
      const idx = players.findIndex((pl) => pl.player_id === playerId);
      return idx >= 0 ? String(idx + 1) : '?';
    },
    [players],
  );

  // ---------------------------------------------------------------------------
  // Trail snapshots (single-round mode)
  // ---------------------------------------------------------------------------
  const trailSnapshots = useMemo(() => {
    if (!showTrails || !sortedTicks.length) return [];
    const idx = nearestTick(currentTick, sortedTicks);
    if (idx === undefined) return [];
    const cursor = sortedTicks.indexOf(idx);
    const approxSteps = Math.ceil(trailLengthTicks / 8);
    const start = Math.max(0, cursor - approxSteps);
    return sortedTicks.slice(start, cursor + 1).map((t) => tickIndex.get(t)!).filter(Boolean);
  }, [showTrails, sortedTicks, currentTick, trailLengthTicks, tickIndex]);

  // ---------------------------------------------------------------------------
  // Current snapshot (single-round mode)
  // ---------------------------------------------------------------------------
  const snapshot = useMemo<TickSnapshot | undefined>(
    () => getSnapshotAtTick(currentTick, tickIndex, sortedTicks),
    [currentTick, tickIndex, sortedTicks],
  );

  // ---------------------------------------------------------------------------
  // Grenades visible at current tick (single-round mode)
  // ---------------------------------------------------------------------------
  const visibleGrenades = useMemo<GrenadeEvent[]>(() => {
    if (!showGrenades || activeRound === null) return [];
    return grenades.filter((g) => {
      if (g.round_number !== activeRound) return false;
      if (currentTick < g.throw_tick) return false;
      if (g.expire_tick !== null && currentTick >= g.expire_tick) return false;
      return true;
    });
  }, [showGrenades, grenades, activeRound, currentTick]);

  // ---------------------------------------------------------------------------
  // Main draw function
  // ---------------------------------------------------------------------------
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvasSize, canvasSize);

    // Apply zoom / pan transform for the whole frame
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    // Background
    if (radarImgRef.current) {
      ctx.drawImage(radarImgRef.current, 0, 0, canvasSize, canvasSize);
    } else {
      ctx.fillStyle = '#1a2332';
      ctx.fillRect(0, 0, canvasSize, canvasSize);
      ctx.strokeStyle = '#2a3a52'; ctx.lineWidth = 1;
      const step = canvasSize / 8;
      for (let i = 0; i <= 8; i++) {
        ctx.beginPath(); ctx.moveTo(i * step, 0); ctx.lineTo(i * step, canvasSize); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i * step); ctx.lineTo(canvasSize, i * step); ctx.stroke();
      }
      ctx.fillStyle = '#4a5a6a'; ctx.font = '14px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        demo ? `${demo.map_name} — radar image not found` : 'No demo loaded',
        canvasSize / 2, canvasSize / 2,
      );
    }

    if (!calibration) { ctx.restore(); return; }

    // Player markers scale inversely with zoom so they stay visually constant size
    const markerR = MARKER_RADIUS / zoom;

    // ---- Heatmap mode ----
    if (isHeatmapMode && heatmapImgRef.current) {
      ctx.globalAlpha = 0.75;
      ctx.drawImage(heatmapImgRef.current, 0, 0, canvasSize, canvasSize);
      ctx.restore();
      return;
    }

    // ---- Multi-round overlay mode ----
    if (isMultiRoundMode && perRoundData) {
      for (const rn of multiRoundSelectedRounds) {
        const roundInfo = rounds.find((r) => r.round_number === rn);
        if (!roundInfo) continue;
        const rdData = perRoundData.get(rn);
        if (!rdData) continue;

        const absoluteTick = roundInfo.freeze_end_tick + multiRoundRelativeTick;
        if (absoluteTick > roundInfo.end_tick) continue;  // this round ended

        const snap = getSnapshotAtTick(absoluteTick, rdData.tickIndex, rdData.sortedTicks);
        if (!snap) continue;

        for (const [pid, pos] of snap.entries()) {
          const alive = pos.is_alive === 1;
          const { cx, cy } = worldToCanvas(pos.x, pos.y, calibration, canvasSize);
          drawPlayerMarker(ctx, cx, cy, MULTI_DOT_COLOR, playerLabel(pid), 1, alive, false, markerR);
        }
      }

      // Draw grenades for multi-round (selected players only)
      if (showGrenades) {
        for (const rn of multiRoundSelectedRounds) {
          const roundInfo = rounds.find((r) => r.round_number === rn);
          if (!roundInfo) continue;
          const absoluteTick = roundInfo.freeze_end_tick + multiRoundRelativeTick;
          const roundGrenades = grenades.filter((g) => {
            if (g.round_number !== rn) return false;
            if (multiRoundSelectedPlayers.size > 0 && !multiRoundSelectedPlayers.has(g.thrower_id)) return false;
            if (absoluteTick < g.throw_tick) return false;
            if (g.expire_tick !== null && absoluteTick >= g.expire_tick) return false;
            return true;
          });
          const rdData = perRoundData.get(rn);
          for (const g of roundGrenades) {
            const throwSnap = rdData
              ? getSnapshotAtTick(g.throw_tick, rdData.tickIndex, rdData.sortedTicks)
              : undefined;
            const throwerPos = throwSnap?.get(g.thrower_id);
            if (!throwerPos && g.detonate_tick === null) continue;
            const { cx: txCx, cy: txCy } = throwerPos
              ? worldToCanvas(throwerPos.x, throwerPos.y, calibration, canvasSize)
              : worldToCanvas(g.x, g.y, calibration, canvasSize);
            const { cx: dxCx, cy: dxCy } = worldToCanvas(g.x, g.y, calibration, canvasSize);
            const trajectoryPoints = (g.trajectory ?? []).map((pt) => {
              const { cx, cy } = worldToCanvas(pt.x, pt.y, calibration, canvasSize);
              return { tick: pt.tick, cx, cy };
            });
            drawGrenade(
              ctx, g, absoluteTick, txCx, txCy, dxCx, dxCy, canvasSize, trajectoryPoints,
            );
          }
        }
      }
      ctx.restore();
      return;
    }

    // ---- Single-round mode ----
    if (!snapshot) { ctx.restore(); return; }

    // Trails
    if (showTrails && trailSnapshots.length > 1) {
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

    // Grenades (single-round)
    if (showGrenades && calibration) {
      for (const g of visibleGrenades) {
        const throwSnap = getSnapshotAtTick(g.throw_tick, tickIndex, sortedTicks);
        const throwerPos = throwSnap?.get(g.thrower_id);
        const { cx: dxCx, cy: dxCy } = worldToCanvas(g.x, g.y, calibration, canvasSize);
        const { cx: txCx, cy: txCy } = throwerPos
          ? worldToCanvas(throwerPos.x, throwerPos.y, calibration, canvasSize)
          : { cx: dxCx, cy: dxCy };
        const trajectoryPoints = (g.trajectory ?? []).map((pt) => {
          const { cx, cy } = worldToCanvas(pt.x, pt.y, calibration, canvasSize);
          return { tick: pt.tick, cx, cy };
        });
        drawGrenade(ctx, g, currentTick, txCx, txCy, dxCx, dxCy, canvasSize, trajectoryPoints);
      }
    }

    // Player markers
    for (const [pid, pos] of snapshot.entries()) {
      const alive = pos.is_alive === 1 || pos.is_alive === (true as unknown as number);
      if (!showDeadPlayers && !alive) continue;
      const isSelected = selectedPlayerIds.has(pid);
      const color = pos.team_num === 3 ? TEAM_COLORS.CT : TEAM_COLORS.T;
      const { cx, cy } = worldToCanvas(pos.x, pos.y, calibration, canvasSize);
      drawPlayerMarker(
        ctx, cx, cy, color, playerLabel(pid), 1, alive, isSelected,
        markerR,
        showYaw && pos.yaw != null ? pos.yaw : undefined,
      );
    }

    ctx.restore();
  }, [
    canvasSize, calibration, snapshot, showDeadPlayers, showTrails, trailSnapshots,
    selectedPlayerIds, playerLabel, isHeatmapMode, demo, showGrenades, showYaw,
    visibleGrenades, tickIndex, sortedTicks, currentTick, zoom, panX, panY,
    isMultiRoundMode, perRoundData, multiRoundSelectedRounds, multiRoundRelativeTick,
    multiRoundSelectedPlayers, rounds, grenades,
  ]);

  useEffect(() => { drawFrame(); }, [drawFrame]);

  // ---------------------------------------------------------------------------
  // Click handler  (accounts for zoom/pan transform)
  // ---------------------------------------------------------------------------
  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!snapshot || !calibration || isMultiRoundMode) return;
      if (isDragging.current) return;  // suppress click after pan
      const rect = canvasRef.current!.getBoundingClientRect();
      // Convert screen coords → world-space canvas coords
      const clickX = (e.clientX - rect.left - panX) / zoom;
      const clickY = (e.clientY - rect.top  - panY) / zoom;
      const togglePlayer = useAppStore.getState().togglePlayerSelection;
      const hitRadius = (MARKER_RADIUS + 4) / zoom;
      for (const [pid, pos] of snapshot.entries()) {
        const { cx, cy } = worldToCanvas(pos.x, pos.y, calibration, canvasSize);
        if (Math.hypot(clickX - cx, clickY - cy) < hitRadius) {
          togglePlayer(pid);
          break;
        }
      }
    },
    [snapshot, calibration, canvasSize, isMultiRoundMode, zoom, panX, panY],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div ref={containerRef} className={styles.container}>
      {zoom > 1 && (
        <button
          className={styles.resetZoomBtn}
          onClick={resetView}
          title="Reset zoom (double-click canvas)"
        >
          {zoom.toFixed(1)}× Reset
        </button>
      )}
      <canvas
        ref={canvasRef}
        width={canvasSize}
        height={canvasSize}
        className={styles.canvas}
        style={{ cursor: isDragging.current ? 'grabbing' : zoom > 1 ? 'grab' : 'default' }}
        onClick={handleCanvasClick}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={resetView}
        title={isMultiRoundMode ? 'Multi-round overlay active' : 'Scroll to zoom · Alt+drag or middle-drag to pan · Double-click to reset'}
      />
      {demo && !isHeatmapMode && !isMultiRoundMode && <Killfeed />}
      {heatmapLoading && (
        <div className={styles.loadingOverlay}><span>Generating heatmap…</span></div>
      )}
      {isMultiRoundMode && (
        <div className={styles.multiRoundBadge}>
          Multi-round overlay — {multiRoundSelectedRounds.length} rounds
        </div>
      )}
      {!demo && (
        <div className={styles.emptyState}><p>Load a demo to begin</p></div>
      )}
    </div>
  );
};

export default RadarViewer;

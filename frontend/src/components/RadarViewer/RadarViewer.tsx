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
 *
 * Drawing primitives live in ./drawing.ts.
 * Zoom/pan interaction is managed by ./useZoomPan.ts.
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
import type { GrenadeEvent, TickSnapshot } from '../../types';
import { TEAM_COLORS } from '../../types';
import Killfeed from '../Killfeed/Killfeed';
import { worldToCanvas, type CalibrationParams } from '../../utils/coordinates';
import {
  getInterpolatedSnapshot,
  getSnapshotAtTick,
  getSortedTicks,
  nearestTickIndex,
  type TickIndex,
} from '../../utils/playback';
import {
  DEFAULT_EFFECT_TICKS,
  MARKER_RADIUS,
  MULTI_DOT_COLOR,
  drawBombCarried,
  drawBombPlanted,
  drawGrenade,
  drawPlayerMarker,
  drawTrail,
} from './drawing';
import { useZoomPan } from './useZoomPan';
import styles from './RadarViewer.module.css';

// ---------------------------------------------------------------------------
// Map calibrations (mirrors backend calibration.py)
// ---------------------------------------------------------------------------
const MAP_CALIBRATIONS: Record<string, CalibrationParams> = {
  de_dust2:    { pos_x: -2476, pos_y:  3239, scale: 4.4,  rotate: 0 },
  de_mirage:   { pos_x: -3230, pos_y:  1713, scale: 5.0,  rotate: 0 },
  de_inferno:  { pos_x: -2087, pos_y:  3870, scale: 4.9,  rotate: 0 },
  de_cache:    { pos_x: -2000, pos_y:  3250, scale: 5.5,  rotate: 0 },
  de_overpass: { pos_x: -4831, pos_y:  1781, scale: 5.2,  rotate: 0 },
  de_ancient:  { pos_x: -2953, pos_y:  2164, scale: 5.0,  rotate: 0 },
  de_anubis:   { pos_x: -2796, pos_y:  3328, scale: 5.22, rotate: 0 },
  de_vertigo:  { pos_x: -3168, pos_y:  1762, scale: 4.0,  rotate: 0 },
  de_nuke:     { pos_x: -3453, pos_y:  2887, scale: 7.0,  rotate: 0 },
  de_train:    { pos_x: -2477, pos_y:  2392, scale: 4.7,  rotate: 0 },
  de_office:   { pos_x: -1838, pos_y:  1858, scale: 4.1,  rotate: 0 },
  cs_italy:    { pos_x: -2647, pos_y:  2592, scale: 4.6,  rotate: 0 },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const RadarViewer: React.FC = () => {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const radarImgRef  = useRef<HTMLImageElement | null>(null);
  const dprRef       = useRef(1);
  // Off-screen canvas caching the static background (radar image or grid
  // placeholder). Rebuilt only when its inputs change, then blitted per frame.
  const bgCanvasRef  = useRef<HTMLCanvasElement | null>(null);
  const bgKeyRef     = useRef('');
  const [canvasSize, setCanvasSize] = useState(600);

  const { zoom, panX, panY, isDragging, handleWheel, handleMouseDown, handleMouseMove, handleMouseUp, resetView } =
    useZoomPan(canvasRef, canvasSize);

  // Store selectors
  const demo              = useAppStore((s) => s.demo);
  const players           = useAppStore((s) => s.players);
  const currentTick       = useAppStore((s) => s.currentTick);
  const tickIndex         = useAppStore((s) => s.tickIndex);
  const sortedTicks       = useAppStore((s) => s.sortedTicks);
  const showDeadPlayers   = useAppStore((s) => s.showDeadPlayers);
  const showTrails        = useAppStore((s) => s.showTrails);
  const trailLengthTicks  = useAppStore((s) => s.trailLengthTicks);
  const showGrenades      = useAppStore((s) => s.showGrenades);
  const showYaw           = useAppStore((s) => s.showYaw);
  const selectedPlayerIds = useAppStore((s) => s.selectedPlayerIds);
  const isHeatmapMode     = useAppStore((s) => s.isHeatmapMode);
  const heatmapResult     = useAppStore((s) => s.heatmapResult);
  const heatmapLoading    = useAppStore((s) => s.heatmapLoading);
  const grenades          = useAppStore((s) => s.grenades);
  const activeRound       = useAppStore((s) => s.activeRound);
  const positions         = useAppStore((s) => s.positions);
  const showBomb          = useAppStore((s) => s.showBomb);
  const events            = useAppStore((s) => s.events);
  const playerStateEvents = useAppStore((s) => s.playerStateEvents);

  // Multi-round mode
  const isMultiRoundMode          = useAppStore((s) => s.isMultiRoundMode);
  const multiRoundSelectedRounds  = useAppStore((s) => s.multiRoundSelectedRounds);
  const multiRoundTeamKeys        = useAppStore((s) => s.multiRoundTeamKeys);
  const multiRoundSelectedPlayers = useAppStore((s) => s.multiRoundSelectedPlayers);
  const multiRoundRelativeTick    = useAppStore((s) => s.multiRoundRelativeTick);
  const rounds                    = useAppStore((s) => s.rounds);
  const teamSession               = useAppStore((s) => s.teamSession);

  // Effective multi-round selection as composite "demoId:roundNumber" keys.
  // In team-session mode this is `multiRoundTeamKeys` directly; otherwise it's
  // synthesized from the active demo's id and `multiRoundSelectedRounds`.
  const effectiveMultiKeys = useMemo<string[]>(() => {
    if (!isMultiRoundMode) return [];
    if (teamSession) return multiRoundTeamKeys;
    if (!demo) return [];
    return multiRoundSelectedRounds.map((rn) => `${demo.id}:${rn}`);
  }, [isMultiRoundMode, teamSession, demo, multiRoundSelectedRounds, multiRoundTeamKeys]);

  // Resolve a (demoId, roundNumber) pair to its RoundInfo. Uses teamSession.rounds
  // when in a team session, otherwise the active demo's `rounds`.
  const resolveRoundInfo = useCallback(
    (demoId: string, rn: number) => {
      if (teamSession) {
        return teamSession.rounds.find((r) => r.demo_id === demoId && r.round_number === rn);
      }
      return rounds.find((r) => r.round_number === rn);
    },
    [teamSession, rounds],
  );

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
    img.src = `/maps/${demo.map_name}.png`;
    img.onload = () => {
      radarImgRef.current = img;
      drawFrame();
    };
    img.onerror = () => {
      radarImgRef.current = null;
      drawFrame();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo?.map_name]);

  // ---------------------------------------------------------------------------
  // Heatmap overlay image
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
  // Size the canvas backing store for the device pixel ratio so rendering is
  // crisp on HiDPI / Retina displays. CSS size stays at canvasSize logical px,
  // so click math and the drawing coordinate system are unaffected.
  // ---------------------------------------------------------------------------
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    dprRef.current = dpr;
    canvas.width = Math.max(1, Math.round(canvasSize * dpr));
    canvas.height = Math.max(1, Math.round(canvasSize * dpr));
    canvas.style.width = `${canvasSize}px`;
    canvas.style.height = `${canvasSize}px`;
    bgKeyRef.current = ''; // force background cache rebuild at new size/dpr
  }, [canvasSize]);

  // ---------------------------------------------------------------------------
  // Per-round index for multi-round mode (O(n) one pass).
  // Keyed by composite "demoId:roundNumber" so the same round_number from
  // different demos in a team session doesn't collide.
  // ---------------------------------------------------------------------------
  const perRoundData = useMemo<Map<
    string,
    { tickIndex: TickIndex; sortedTicks: number[] }
  > | null>(() => {
    if (!isMultiRoundMode || effectiveMultiKeys.length === 0) return null;
    const selectedSet = new Set(effectiveMultiKeys);
    const fallbackDemoId = demo?.id ?? '';
    const roundIndexes = new Map<string, TickIndex>();

    for (const pos of positions) {
      const posDemoId = pos.demo_id ?? fallbackDemoId;
      const key = `${posDemoId}:${pos.round_number}`;
      if (!selectedSet.has(key)) continue;
      if (multiRoundSelectedPlayers.size > 0 && !multiRoundSelectedPlayers.has(pos.player_id))
        continue;
      if (!roundIndexes.has(key)) roundIndexes.set(key, new Map());
      const idx = roundIndexes.get(key)!;
      let snap = idx.get(pos.tick);
      if (!snap) {
        snap = new Map();
        idx.set(pos.tick, snap);
      }
      snap.set(pos.player_id, pos);
    }

    const result = new Map<string, { tickIndex: TickIndex; sortedTicks: number[] }>();
    for (const [key, idx] of roundIndexes.entries()) {
      result.set(key, { tickIndex: idx, sortedTicks: getSortedTicks(idx) });
    }
    return result;
  }, [isMultiRoundMode, effectiveMultiKeys, multiRoundSelectedPlayers, positions, demo?.id]);

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
    const cursor = nearestTickIndex(currentTick, sortedTicks);
    if (cursor === -1) return [];
    const approxSteps = Math.ceil(trailLengthTicks / 8);
    const start = Math.max(0, cursor - approxSteps);
    return sortedTicks.slice(start, cursor + 1).map((t) => tickIndex.get(t)!).filter(Boolean);
  }, [showTrails, sortedTicks, currentTick, trailLengthTicks, tickIndex]);

  // ---------------------------------------------------------------------------
  // Current snapshot (single-round mode)
  // ---------------------------------------------------------------------------
  const snapshot = useMemo<TickSnapshot | undefined>(
    () => getInterpolatedSnapshot(currentTick, tickIndex, sortedTicks),
    [currentTick, tickIndex, sortedTicks],
  );

  // ---------------------------------------------------------------------------
  // Grenades visible at current tick (single-round mode)
  // ---------------------------------------------------------------------------
  const visibleGrenades = useMemo<GrenadeEvent[]>(() => {
    if (!showGrenades || activeRound === null) return [];
    // Scale the fallback effect duration to this demo's tick rate (the defaults
    // are calibrated at 64 tick, so a 128-tick demo needs ~2× the ticks).
    const tickScale = demo && demo.tick_rate > 0 ? demo.tick_rate / 64 : 1;
    return grenades.filter((g) => {
      if (g.round_number !== activeRound) return false;
      if (currentTick < g.throw_tick) return false;
      // Use expire_tick if set; otherwise fall back to detonate_tick + default duration.
      // Without this, grenades with null expire_tick never disappear.
      const effectiveExpire =
        g.expire_tick ??
        (g.detonate_tick !== null
          ? g.detonate_tick + Math.round((DEFAULT_EFFECT_TICKS[g.grenade_type] ?? 64) * tickScale)
          : null);
      if (effectiveExpire !== null && currentTick >= effectiveExpire) return false;
      return true;
    });
  }, [showGrenades, grenades, activeRound, currentTick, demo]);

  // ---------------------------------------------------------------------------
  // C4 equip events for the active round, sorted by tick. Precomputed so the
  // draw loop doesn't linear-scan ALL player-state events every frame to find
  // the current bomb carrier.
  // ---------------------------------------------------------------------------
  const c4EquipsThisRound = useMemo<Array<{ tick: number; playerId: number }>>(() => {
    if (activeRound === null) return [];
    const out: Array<{ tick: number; playerId: number }> = [];
    for (const ev of playerStateEvents) {
      if (ev.round_number !== activeRound || ev.event_type !== 'equip') continue;
      const w = typeof ev.weapon === 'string' ? ev.weapon.toLowerCase().trim() : '';
      const norm = w.startsWith('weapon_') || w.startsWith('item_') ? w : w ? `weapon_${w}` : '';
      if (norm === 'weapon_c4') out.push({ tick: ev.tick, playerId: ev.player_id });
    }
    return out.sort((a, b) => a.tick - b.tick);
  }, [playerStateEvents, activeRound]);

  // ---------------------------------------------------------------------------
  // Main draw function
  // ---------------------------------------------------------------------------
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = dprRef.current;
    // Base transform scales everything by the device pixel ratio (HiDPI), then
    // the per-frame pan/zoom is layered on top.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasSize, canvasSize);
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    // Background — rebuild the cached off-screen layer only when its inputs
    // change, then blit it. Avoids re-running the grid/text draw every frame.
    const ensureBackground = (): HTMLCanvasElement | null => {
      const hasImg = !!radarImgRef.current;
      const key = `${canvasSize}|${dpr}|${hasImg ? '1' : '0'}|${demo?.map_name ?? ''}`;
      if (bgKeyRef.current === key && bgCanvasRef.current) return bgCanvasRef.current;
      let bg = bgCanvasRef.current;
      if (!bg) {
        bg = document.createElement('canvas');
        bgCanvasRef.current = bg;
      }
      bg.width = Math.max(1, Math.round(canvasSize * dpr));
      bg.height = Math.max(1, Math.round(canvasSize * dpr));
      const bctx = bg.getContext('2d');
      if (!bctx) return null;
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.clearRect(0, 0, canvasSize, canvasSize);
      if (radarImgRef.current) {
        bctx.drawImage(radarImgRef.current, 0, 0, canvasSize, canvasSize);
      } else {
        bctx.fillStyle = '#1a2332';
        bctx.fillRect(0, 0, canvasSize, canvasSize);
        bctx.strokeStyle = '#2a3a52';
        bctx.lineWidth = 1;
        const step = canvasSize / 8;
        for (let i = 0; i <= 8; i++) {
          bctx.beginPath();
          bctx.moveTo(i * step, 0);
          bctx.lineTo(i * step, canvasSize);
          bctx.stroke();
          bctx.beginPath();
          bctx.moveTo(0, i * step);
          bctx.lineTo(canvasSize, i * step);
          bctx.stroke();
        }
        bctx.fillStyle = '#4a5a6a';
        bctx.font = '14px Inter, sans-serif';
        bctx.textAlign = 'center';
        bctx.fillText(
          demo ? `${demo.map_name} — radar image not found` : 'No demo loaded',
          canvasSize / 2,
          canvasSize / 2,
        );
      }
      bgKeyRef.current = key;
      return bg;
    };

    const bgCanvas = ensureBackground();
    if (bgCanvas) ctx.drawImage(bgCanvas, 0, 0, canvasSize, canvasSize);

    if (!calibration) {
      ctx.restore();
      return;
    }

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
      for (const key of effectiveMultiKeys) {
        const sep = key.indexOf(':');
        const dId = key.slice(0, sep);
        const rn = parseInt(key.slice(sep + 1), 10);
        const roundInfo = resolveRoundInfo(dId, rn);
        if (!roundInfo) continue;
        const rdData = perRoundData.get(key);
        if (!rdData) continue;

        const absoluteTick = roundInfo.freeze_end_tick + multiRoundRelativeTick;
        if (absoluteTick > roundInfo.end_tick) continue; // this round ended

        const snap = getSnapshotAtTick(absoluteTick, rdData.tickIndex, rdData.sortedTicks);
        if (!snap) continue;

        for (const [pid, pos] of snap.entries()) {
          const alive = Boolean(pos.is_alive);
          const { cx, cy } = worldToCanvas(pos.x, pos.y, calibration, canvasSize);
          drawPlayerMarker(ctx, cx, cy, MULTI_DOT_COLOR, playerLabel(pid), 1, alive, false, markerR);
        }
      }

      // Draw grenades for multi-round. In team-session mode grenades are only
      // loaded for the active demo, so restrict to keys matching its id.
      if (showGrenades) {
        const activeDemoId = demo?.id;
        for (const key of effectiveMultiKeys) {
          const sep = key.indexOf(':');
          const dId = key.slice(0, sep);
          const rn = parseInt(key.slice(sep + 1), 10);
          if (teamSession && dId !== activeDemoId) continue;
          const roundInfo = resolveRoundInfo(dId, rn);
          if (!roundInfo) continue;
          const absoluteTick = roundInfo.freeze_end_tick + multiRoundRelativeTick;
          const roundGrenades = grenades.filter((g) => {
            if (g.round_number !== rn) return false;
            if (
              multiRoundSelectedPlayers.size > 0 &&
              !multiRoundSelectedPlayers.has(g.thrower_id)
            )
              return false;
            if (absoluteTick < g.throw_tick) return false;
            if (g.expire_tick !== null && absoluteTick >= g.expire_tick) return false;
            return true;
          });
          const rdData = perRoundData.get(key);
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
            const trajectoryPoints = (g.trajectory ?? [])
              .filter((pt) => pt.x != null && pt.y != null)
              .map((pt) => {
                const { cx, cy } = worldToCanvas(pt.x, pt.y, calibration, canvasSize);
                return { tick: pt.tick, cx, cy };
              })
              .filter((pt) => isFinite(pt.cx) && isFinite(pt.cy));
            drawGrenade(ctx, g, absoluteTick, txCx, txCy, dxCx, dxCy, canvasSize, trajectoryPoints);
          }
        }
      }
      ctx.restore();
      return;
    }

    // ---- Single-round mode ----
    if (!snapshot) {
      ctx.restore();
      return;
    }

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
    if (showGrenades) {
      for (const g of visibleGrenades) {
        const throwSnap = getSnapshotAtTick(g.throw_tick, tickIndex, sortedTicks);
        const throwerPos = throwSnap?.get(g.thrower_id);
        const { cx: dxCx, cy: dxCy } = worldToCanvas(g.x, g.y, calibration, canvasSize);
        const { cx: txCx, cy: txCy } = throwerPos
          ? worldToCanvas(throwerPos.x, throwerPos.y, calibration, canvasSize)
          : { cx: dxCx, cy: dxCy };
        const trajectoryPoints = (g.trajectory ?? [])
          .filter((pt) => pt.x != null && pt.y != null)
          .map((pt) => {
            const { cx, cy } = worldToCanvas(pt.x, pt.y, calibration, canvasSize);
            return { tick: pt.tick, cx, cy };
          })
          .filter((pt) => isFinite(pt.cx) && isFinite(pt.cy));
        drawGrenade(ctx, g, currentTick, txCx, txCy, dxCx, dxCy, canvasSize, trajectoryPoints);
      }
    }

    // Planted bomb (drawn before player markers so players appear on top)
    if (showBomb) {
      const bombRoundInfo = rounds.find((r) => r.round_number === activeRound);
      if (bombRoundInfo) {
        const { bomb_planted_tick, bomb_defused_tick, bomb_exploded_tick } = bombRoundInfo;
        if (bomb_planted_tick !== null && currentTick >= bomb_planted_tick) {
          const plantEvent = events.find(
            (e) => e.round_number === activeRound && e.event_type === 'bomb_planted',
          );
          if (plantEvent?.attacker_id) {
            const plantSnap = getSnapshotAtTick(bomb_planted_tick, tickIndex, sortedTicks);
            const planterPos = plantSnap?.get(plantEvent.attacker_id);
            if (planterPos) {
              const { cx, cy } = worldToCanvas(
                planterPos.x,
                planterPos.y,
                calibration,
                canvasSize,
              );
              const ageTicks = currentTick - bomb_planted_tick;
              const isDefused = bomb_defused_tick !== null && currentTick >= bomb_defused_tick;
              const isExploded = bomb_exploded_tick !== null && currentTick >= bomb_exploded_tick;
              drawBombPlanted(ctx, cx, cy, ageTicks, isDefused, isExploded, zoom);
            }
          }
        }
      }
    }

    // Player markers
    for (const [pid, pos] of snapshot.entries()) {
      const alive = Boolean(pos.is_alive);
      if (!showDeadPlayers && !alive) continue;
      const isSelected = selectedPlayerIds.has(pid);
      const color = pos.team_num === 3 ? TEAM_COLORS.CT : TEAM_COLORS.T;
      const { cx, cy } = worldToCanvas(pos.x, pos.y, calibration, canvasSize);
      drawPlayerMarker(
        ctx,
        cx,
        cy,
        color,
        playerLabel(pid),
        1,
        alive,
        isSelected,
        markerR,
        showYaw && pos.yaw != null ? pos.yaw : undefined,
      );
    }

    // Bomb carrier badge (drawn after player markers so it appears on top)
    if (showBomb) {
      const bombRoundInfo = rounds.find((r) => r.round_number === activeRound);
      const bombPlantedTick = bombRoundInfo?.bomb_planted_tick ?? null;
      if (bombPlantedTick === null || currentTick < bombPlantedTick) {
        // Last C4 equip at or before the current tick (events are pre-sorted).
        let carrierId: number | null = null;
        for (const e of c4EquipsThisRound) {
          if (e.tick > currentTick) break;
          carrierId = e.playerId;
        }
        if (carrierId !== null) {
          const carrierPos = snapshot.get(carrierId);
          if (carrierPos) {
            const { cx, cy } = worldToCanvas(
              carrierPos.x,
              carrierPos.y,
              calibration,
              canvasSize,
            );
            drawBombCarried(ctx, cx, cy, zoom);
          }
        }
      }
    }

    ctx.restore();
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
    showGrenades,
    showYaw,
    visibleGrenades,
    tickIndex,
    sortedTicks,
    currentTick,
    zoom,
    panX,
    panY,
    isMultiRoundMode,
    perRoundData,
    effectiveMultiKeys,
    multiRoundRelativeTick,
    multiRoundSelectedPlayers,
    rounds,
    grenades,
    teamSession,
    resolveRoundInfo,
    showBomb,
    events,
    c4EquipsThisRound,
    activeRound,
  ]);

  useEffect(() => {
    drawFrame();
  }, [drawFrame]);

  // ---------------------------------------------------------------------------
  // Click handler  (accounts for zoom/pan transform)
  // ---------------------------------------------------------------------------
  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!snapshot || !calibration || isMultiRoundMode) return;
      if (isDragging.current) return; // suppress click after pan
      const rect = canvasRef.current!.getBoundingClientRect();
      const clickX = (e.clientX - rect.left - panX) / zoom;
      const clickY = (e.clientY - rect.top - panY) / zoom;
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
    [snapshot, calibration, canvasSize, isMultiRoundMode, zoom, panX, panY, isDragging],
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
        className={styles.canvas}
        style={{ cursor: isDragging.current ? 'grabbing' : zoom > 1 ? 'grab' : 'default' }}
        onClick={handleCanvasClick}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={resetView}
        title={
          isMultiRoundMode
            ? 'Multi-round overlay active'
            : 'Scroll to zoom · Alt+drag or middle-drag to pan · Double-click to reset'
        }
      />
      {demo && !isHeatmapMode && !isMultiRoundMode && <Killfeed />}
      {heatmapLoading && (
        <div className={styles.loadingOverlay}>
          <span>Generating heatmap…</span>
        </div>
      )}
      {useAppStore((s) => s.positionsLoading) && !heatmapLoading && (
        <div className={styles.loadingOverlay}>
          <span>Loading round…</span>
        </div>
      )}
      {isMultiRoundMode && (
        <div className={styles.multiRoundBadge}>
          Multi-round overlay — {effectiveMultiKeys.length} rounds
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

/**
 * Pure canvas drawing primitives for RadarViewer.
 * No React imports — these are plain functions that write to a 2D context.
 */

import type { GrenadeEvent } from '../../types';

// ---------------------------------------------------------------------------
// Exported constants (also read by RadarViewer for hit-testing, zoom math, etc.)
// ---------------------------------------------------------------------------

export const MARKER_RADIUS = 7;

export const MULTI_DOT_COLOR = '#c8d8e8';

// Default effect durations in ticks (at 64 ticks/s) when expire_tick is absent.
export const DEFAULT_EFFECT_TICKS: Record<string, number> = {
  smoke:      1152,  // ~18 s
  molotov:     448,  // ~7 s
  incendiary:  448,
  he:           32,  // ~0.5 s
  flash:        64,  // ~1 s
  decoy:       256,  // ~4 s
};

// ---------------------------------------------------------------------------
// Private constants
// ---------------------------------------------------------------------------

const FONT_SIZE = 10;
const TRAIL_ALPHA_MAX = 0.55;
const DEAD_ALPHA = 0.35;

const SMOKE_RADIUS_PX   = 40;
const MOLOTOV_RADIUS_PX = 28;
const HE_RADIUS_PX      = 18;
const FLASH_RADIUS_PX   = 14;

// ---------------------------------------------------------------------------
// Player marker
// ---------------------------------------------------------------------------

export function drawPlayerMarker(
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
    const wedgeHalf = Math.PI / 6; // ±30° spread
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
    ctx.moveTo(cx - d, cy - d);
    ctx.lineTo(cx + d, cy + d);
    ctx.moveTo(cx + d, cy - d);
    ctx.lineTo(cx - d, cy + d);
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

// ---------------------------------------------------------------------------
// Trail
// ---------------------------------------------------------------------------

export function drawTrail(
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
// Grenade
// ---------------------------------------------------------------------------

export function grenadeLineColor(type: string): string {
  switch (type) {
    case 'smoke':
      return '#b0c8d8';
    case 'he':
      return '#ffd040';
    case 'flash':
      return '#e8e8ff';
    case 'molotov':
    case 'incendiary':
      return '#ff6020';
    case 'decoy':
      return '#a0a0c0';
    default:
      return '#cccccc';
  }
}

export function drawGrenade(
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
  const { throw_tick, detonate_tick, grenade_type } = g;
  const effectiveExpire =
    g.expire_tick ??
    (detonate_tick !== null
      ? detonate_tick + (DEFAULT_EFFECT_TICKS[grenade_type] ?? 64)
      : null);
  const expire_tick = effectiveExpire;
  const inFlight = detonate_tick !== null && currentTick >= throw_tick && currentTick < detonate_tick;
  const detonated = detonate_tick !== null && currentTick >= detonate_tick;
  const expired = expire_tick !== null && currentTick >= expire_tick;

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

    // Draw only the recent tail from the grenade's own trajectory positions —
    // never the throw position (the thrower's feet). When several grenades
    // launch from the same spot the throw-position point is a shared pixel;
    // including it makes every trail converge there and fan out = starburst.
    const GRENADE_TRAIL_TICKS = 48; // ~0.75 s at 64 Hz
    const trailStart = currentTick - GRENADE_TRAIL_TICKS;
    const drawnPath = trajectoryPoints.filter(
      (p) => p.tick >= trailStart && p.tick <= currentTick,
    );
    if (drawnPath.length > 0) {
      ctx.setLineDash([3, 4]);
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.moveTo(drawnPath[0].cx, drawnPath[0].cy);
      for (let i = 1; i < drawnPath.length; i++) {
        ctx.lineTo(drawnPath[i].cx, drawnPath[i].cy);
      }
      ctx.lineTo(gx, gy);
      ctx.strokeStyle = grenadeLineColor(grenade_type);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(gx, gy, 4, 0, Math.PI * 2);
    ctx.fillStyle = grenadeLineColor(grenade_type);
    ctx.fill();
  }

  if (detonated && !expired) {
    const age = currentTick - detonate_tick!;
    const maxAge = expire_tick ? expire_tick - detonate_tick! : 64;
    const fadeRatio = 1 - Math.min(1, age / maxAge);

    switch (grenade_type) {
      case 'smoke': {
        const growTicks = 96; // ~1.5 s expansion
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
        // Burst grows to full size in 8 ticks, then fades — cap growth so
        // grenades with null expire_tick can't produce a runaway radius.
        const r = HE_RADIUS_PX * (1 + Math.min(1, age / 8)) * (canvasSize / 1024);
        ctx.globalAlpha = 0.7 * fadeRatio;
        ctx.beginPath();
        ctx.arc(detonateCx, detonateCy, r, 0, Math.PI * 2);
        ctx.fillStyle = '#ffdd44';
        ctx.fill();
        break;
      }
      case 'flash': {
        const r = FLASH_RADIUS_PX * (1 + Math.min(1, age / 6)) * (canvasSize / 1024);
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

// ---------------------------------------------------------------------------
// Bomb
// ---------------------------------------------------------------------------

export function drawBombPlanted(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  ageTicks: number,
  isDefused: boolean,
  isExploded: boolean,
  zoom: number,
): void {
  ctx.save();
  const r = 9 / zoom;
  if (isExploded) {
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ff7700';
    ctx.fill();
    ctx.strokeStyle = '#ffdd00';
    ctx.lineWidth = 2 / zoom;
    ctx.stroke();
  } else if (isDefused) {
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#2060c0';
    ctx.fill();
    ctx.strokeStyle = '#80b0ff';
    ctx.lineWidth = 1.5 / zoom;
    ctx.stroke();
  } else {
    const pulse = 0.5 + 0.5 * Math.sin((ageTicks / 8) * Math.PI);
    ctx.globalAlpha = 0.7 + 0.3 * pulse;
    ctx.beginPath();
    ctx.arc(cx, cy, r * (1 + 0.15 * pulse), 0, Math.PI * 2);
    ctx.fillStyle = '#dd2020';
    ctx.fill();
    ctx.strokeStyle = '#ff6060';
    ctx.lineWidth = 1.5 / zoom;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.font = `bold ${10 / zoom}px 'JetBrains Mono', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('B', cx, cy + 0.5 / zoom);
  ctx.restore();
}

export function drawBombCarried(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  zoom: number,
): void {
  const offset = (MARKER_RADIUS + 4) / zoom;
  const r = 4 / zoom;
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(cx + offset, cy - offset, r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffdd00';
  ctx.fill();
  ctx.strokeStyle = '#cc8800';
  ctx.lineWidth = 1 / zoom;
  ctx.stroke();
  ctx.restore();
}

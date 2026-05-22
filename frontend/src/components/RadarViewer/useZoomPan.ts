import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject, WheelEvent as ReactWheelEvent, MouseEvent as ReactMouseEvent } from 'react';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

export interface ZoomPanControls {
  zoom: number;
  panX: number;
  panY: number;
  isDragging: RefObject<boolean>;
  handleWheel: (e: ReactWheelEvent<HTMLCanvasElement>) => void;
  handleMouseDown: (e: ReactMouseEvent<HTMLCanvasElement>) => void;
  handleMouseMove: (e: ReactMouseEvent<HTMLCanvasElement>) => void;
  handleMouseUp: () => void;
  resetView: () => void;
}

export function useZoomPan(
  canvasRef: RefObject<HTMLCanvasElement>,
  canvasSize: number,
): ZoomPanControls {
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, px: 0, py: 0 });

  const handleWheel = useCallback(
    (e: ReactWheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setZoom((prev) => {
        const next = clamp(prev * factor, MIN_ZOOM, MAX_ZOOM);
        const rect = canvasRef.current!.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        setPanX((px) => mouseX - (mouseX - px) * (next / prev));
        setPanY((py) => mouseY - (mouseY - py) * (next / prev));
        return next;
      });
    },
    [canvasRef],
  );

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>) => {
      if (e.button !== 1 && !(e.button === 0 && e.altKey)) return;
      e.preventDefault();
      isDragging.current = true;
      dragStart.current = { x: e.clientX, y: e.clientY, px: panX, py: panY };
    },
    [panX, panY],
  );

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

  // Clamp pan so users can't drag beyond the scaled canvas bounds
  useEffect(() => {
    const maxPan = canvasSize * (zoom - 1);
    setPanX((px) => clamp(px, -maxPan, 0));
    setPanY((py) => clamp(py, -maxPan, 0));
  }, [zoom, canvasSize]);

  return { zoom, panX, panY, isDragging, handleWheel, handleMouseDown, handleMouseMove, handleMouseUp, resetView };
}

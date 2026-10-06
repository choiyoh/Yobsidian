import { useCallback, useEffect, useRef, useState } from "react";

function load(key: string, fallback: number, min: number, max: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    if (n >= min && n <= max) return n;
  } catch {
    // storage unavailable: use the default
  }
  return fallback;
}

/**
 * A panel width the user changes by dragging a handle (or with the arrow keys), remembered per device.
 * `side` is the panel's side of the handle: a right panel grows when the handle moves left.
 */
export function useResizableWidth(key: string, fallback: number, min: number, max: number, side: "left" | "right") {
  const [width, setWidth] = useState(() => load(key, fallback, min, max));
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, w: 0 });
  const latest = useRef(width);
  latest.current = width;

  const clamp = useCallback((w: number) => Math.round(Math.min(max, Math.max(min, w))), [min, max]);
  const persist = useCallback(
    (w: number) => {
      try {
        localStorage.setItem(key, String(w));
      } catch {
        // not persisted; fine
      }
    },
    [key],
  );

  // Keep the saved width usable after the window shrinks.
  useEffect(() => {
    const onResize = () => setWidth((w) => Math.min(w, Math.max(min, Math.floor(window.innerWidth * 0.6))));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [min]);

  const handleProps = {
    role: "separator" as const,
    "aria-orientation": "vertical" as const,
    "aria-valuenow": width,
    "aria-valuemin": min,
    "aria-valuemax": max,
    tabIndex: 0,
    title: "드래그해서 너비 조절 (더블클릭: 기본값)",
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      start.current = { x: e.clientX, w: latest.current };
      setDragging(true);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - start.current.x;
      setWidth(clamp(start.current.w + (side === "right" ? -dx : dx)));
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      e.currentTarget.releasePointerCapture(e.pointerId);
      setDragging(false);
      persist(latest.current);
    },
    onDoubleClick: () => {
      setWidth(fallback);
      persist(fallback);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const dir = (e.key === "ArrowLeft" ? -1 : 1) * (side === "right" ? -1 : 1);
      const w = clamp(latest.current + dir * (e.shiftKey ? 48 : 12));
      setWidth(w);
      persist(w);
    },
  };

  return { width, dragging, handleProps };
}

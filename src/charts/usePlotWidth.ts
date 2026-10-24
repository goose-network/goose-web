// src/charts/usePlotWidth.ts — measure a chart's plot container so the SVG
// viewBox matches CSS pixels 1:1.
//
// A fixed 640-unit viewBox stretched to `width: 100%` scaled the 11px axis
// text with the card: ~19px in a full-width card, ~6px (illegible) in the
// half-width grid columns. Measuring keeps text at its true size everywhere.

import { useEffect, useRef, useState } from "react";

export function usePlotWidth(fallback = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, width };
}

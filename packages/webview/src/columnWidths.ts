import { useEffect, useMemo, useState } from 'react';
import type { Snapshot } from './protocol';

const MAX_CONTENT_WIDTH = 480;
const CELL_INSET = 24; // Cell/header padding, border and a little caret space.

function currentFonts() {
  const style = getComputedStyle(document.body);
  return {
    body: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
    heading: `${style.fontStyle} 700 ${style.fontSize} ${style.fontFamily}`,
    code: `${style.fontStyle} 400 11px ${style.fontFamily}`,
  };
}

export function useColumnWidths(snapshot: Snapshot | undefined): number[] {
  const [fonts, setFonts] = useState(currentFonts);
  useEffect(() => {
    const update = () => {
      const next = currentFonts();
      setFonts(previous => previous.body === next.body && previous.heading === next.heading &&
        previous.code === next.code ? previous : next);
    };
    // Theme/font changes need new metrics, but scrolling and typing do not.
    const observer = new MutationObserver(update);
    for (const element of [document.documentElement, document.body]) {
      observer.observe(element, { attributes: true, attributeFilter: ['class', 'style'] });
    }
    void document.fonts.ready.then(update);
    document.fonts.addEventListener('loadingdone', update);
    return () => { observer.disconnect(); document.fonts.removeEventListener('loadingdone', update); };
  }, []);

  return useMemo(() => {
    if (!snapshot) return [];
    const context = document.createElement('canvas').getContext('2d')!;
    const cache = new Map<string, number>();
    function measure(text: string, font: string): number {
      const key = font + '\0' + text;
      const previous = cache.get(key);
      if (previous !== undefined) return previous;
      context.font = font;
      const width = Math.max(0, ...text.split(/\r\n|\r|\n/).map(line => context.measureText(line).width));
      cache.set(key, width);
      return width;
    }
    return Object.entries(snapshot.schema.columns).map(([code, definition]) => {
      const heading = Math.ceil(Math.max(
        measure(definition.label ?? code, fonts.heading),
        measure(`${code} · ${code === snapshot.schema.primary_key ? 'Key' : definition.type}`, fonts.code),
      ) + CELL_INSET);
      let content = 0;
      for (const row of snapshot.rows) {
        const value = row[code] === undefined ? '' : String(row[code]);
        content = Math.max(content, measure(value, fonts.body));
        // Once capped, later rows cannot change this column's width.
        if (content + CELL_INSET >= MAX_CONTENT_WIDTH) break;
      }
      return Math.max(64, heading, Math.min(MAX_CONTENT_WIDTH, Math.ceil(content + CELL_INSET)));
    });
  }, [snapshot?.table, snapshot?.revision, fonts]);
}

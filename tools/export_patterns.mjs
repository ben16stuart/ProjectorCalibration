// Prints the video test patterns as JSON (consumed by make_videos.py), so the
// videos and the in-browser analysis always share one definition.
import { getPattern, VIDEO_PATTERNS } from '../web/js/patterns.js';
import { pq10 } from '../web/js/color.js';

const out = VIDEO_PATTERNS.map((id) => {
  const p = getPattern(id);
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    bg: p.bg,
    elements: p.elements.filter((e) => e.fill).map((e) => ({ rect: e.rect, fill: e.fill })),
    labels: p.labels || [],
    maxcll: p.meta.maxcll ?? null,
  };
});
process.stdout.write(JSON.stringify({ patterns: out, hdrFlashWhite: pq10(100) }));

// One dark stylesheet (M2-SPEC §3), injected from JS so the UI owns its own styling
// without touching the APP-owned index.html. Instrument-panel identity: monospace
// throughout (the product IS monospace glyphs), hairline rules, a single phosphor
// accent. Boldness is spent on the scrubber reveal; everything else stays quiet.

const CSS = `
#ui-root {
  --bg: #06080b;
  --panel: #0d1218;
  --line: #1a222c;
  --line-soft: #131a22;
  --ink: #c9d4de;
  --muted: #6d7b89;
  --dim: #46525f;
  --accent: #7fd6a2;
  --accent-dim: rgba(127,214,162,0.14);
  --font: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.5;
}
#ui-root *, #ui-root *::before, #ui-root *::after { box-sizing: border-box; }

.top {
  display: flex; align-items: baseline; justify-content: space-between; gap: 20px;
  flex-wrap: wrap; padding: 18px 24px; border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: baseline; gap: 12px; }
.brand b { font-size: 17px; font-weight: 700; letter-spacing: 0.02em; }
.brand b span { color: var(--accent); }
.brand .tag { color: var(--muted); font-size: 12px; }
.match { display: flex; align-items: baseline; gap: 8px; }
.match .pct { font-size: 22px; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums; }
.match .lbl { color: var(--muted); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }

.grid { display: grid; grid-template-columns: minmax(0,1fr) 320px; gap: 22px; padding: 22px 24px; align-items: start; }
@media (max-width: 880px) { .grid { grid-template-columns: 1fr; } }

.stage-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }

/* --- scrubber hero --- */
.scrub-stage {
  position: relative; width: 100%; border: 1px solid var(--line); background: #000;
  overflow: hidden; touch-action: none; cursor: ew-resize; user-select: none;
}
.scrub-canvas { display: block; width: 100%; height: auto; image-rendering: pixelated; }
.scrub-tag {
  position: absolute; top: 10px; padding: 3px 8px; font-size: 10px; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--ink); background: rgba(6,8,11,0.72);
  border: 1px solid var(--line); pointer-events: none;
}
.scrub-tag-l { left: 10px; }
.scrub-tag-r { right: 10px; color: var(--accent); }
.scrub-handle {
  position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px;
  background: var(--accent); box-shadow: 0 0 10px rgba(127,214,162,0.6); pointer-events: none;
}
.scrub-handle::after {
  content: "\\21C4"; position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
  width: 26px; height: 26px; display: grid; place-items: center; border-radius: 50%;
  background: var(--accent); color: #06110b; font-size: 13px;
}

.toolbar { display: flex; gap: 8px; }
.toggle {
  display: inline-flex; align-items: center; gap: 7px; padding: 7px 12px; cursor: pointer;
  border: 1px solid var(--line); background: var(--panel); color: var(--muted);
  font-size: 12px; user-select: none;
}
.toggle input { appearance: none; width: 26px; height: 15px; border-radius: 8px; background: var(--line);
  position: relative; cursor: pointer; transition: background 0.12s; flex: none; }
.toggle input::after { content: ""; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px;
  border-radius: 50%; background: var(--dim); transition: transform 0.12s, background 0.12s; }
.toggle input:checked { background: var(--accent-dim); }
.toggle input:checked::after { transform: translateX(11px); background: var(--accent); }
.toggle:has(input:checked) { color: var(--ink); border-color: #2b3a44; }

.viewport { display: flex; align-items: flex-end; gap: 12px; }
.viewport figure { margin: 0; }
#scene { display: block; width: 220px; height: auto; border: 1px solid var(--line);
  image-rendering: auto; background: #000; cursor: grab; }
.viewport figcaption { color: var(--muted); font-size: 11px; margin-top: 6px; }
.hidden-buf { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

/* --- rack of panels --- */
.rack { display: flex; flex-direction: column; gap: 14px; }
.panel { border: 1px solid var(--line); background: var(--panel); }
.eyebrow { padding: 8px 12px; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--dim); border-bottom: 1px solid var(--line-soft); }
.panel-body { padding: 13px 14px; display: flex; flex-direction: column; gap: 12px; }

.badge-wrap { display: flex; align-items: baseline; gap: 9px; }
#ssim { font-size: 34px; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em; line-height: 1; }
.badge-unit { color: var(--muted); font-size: 11px; letter-spacing: 0.12em; }
.ladder-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
.q-btn { padding: 8px 0; cursor: pointer; border: 1px solid var(--line); background: transparent;
  color: var(--muted); font-family: var(--font); font-size: 12px; font-weight: 600; }
.q-btn:hover { color: var(--ink); border-color: #2b3a44; }
.q-btn.active { color: #06110b; background: var(--accent); border-color: var(--accent); }
.ladder-caption { margin: 0; color: var(--muted); font-size: 12px; min-height: 2lh; }

.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 11px; color: var(--muted); letter-spacing: 0.04em; }
.field-input { width: 100%; padding: 7px 9px; background: var(--bg); color: var(--ink);
  border: 1px solid var(--line); font-family: var(--font); font-size: 12px; }
.field-slider-wrap { display: flex; align-items: center; gap: 10px; }
.field-slider { flex: 1; accent-color: var(--accent); }
.field-value { color: var(--accent); font-variant-numeric: tabular-nums; min-width: 3ch; text-align: right; }
.seg { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.seg-btn { padding: 7px 0; cursor: pointer; border: 1px solid var(--line); background: transparent;
  color: var(--muted); font-family: var(--font); font-size: 12px; }
.seg-btn.active { color: #06110b; background: var(--accent); border-color: var(--accent); }

.export-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.export-btn { padding: 8px 0; cursor: pointer; border: 1px solid var(--line); background: transparent;
  color: var(--ink); font-family: var(--font); font-size: 12px; }
.export-btn:hover { border-color: var(--accent); color: var(--accent); }
.export-status { color: var(--accent); font-size: 11px; min-height: 1lh; }
.note { margin: 0; color: var(--dim); font-size: 11px; }

.perf { padding: 10px 24px; border-top: 1px solid var(--line); color: var(--dim);
  font-size: 11px; white-space: pre-wrap; }

#ui-root :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .scrub-handle, .toggle input, .toggle input::after { transition: none; } }
`;

export function injectStyles(): void {
  const style = document.createElement('style');
  style.id = 'ui-style';
  style.textContent = CSS;
  document.head.append(style);
}

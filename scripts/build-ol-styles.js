#!/usr/bin/env node
/*
 * Generates ol-mapbox-style optimized variants of the MapLibre styles, used by
 * the Signal K resources/charts API (consumed by Freeboard, which renders with
 * OpenLayers + ol-mapbox-style instead of MapLibre GL JS).
 *
 *   styles/seamap.json -> styles/seamap-ol.json
 *   styles/slim.json   -> styles/seamap-ol-slim.json
 *
 * Re-run after editing the source styles:  node scripts/build-ol-styles.js
 *
 * Applied transforms (see https://github.com/.../issues/1 discussion):
 *
 *  A. Icon/label visibility. ol-mapbox-style's getDeclutterMode() only reads the
 *     legacy `icon-allow-overlap` / `text-allow-overlap` properties, NOT the new
 *     MapLibre `icon-overlap` / `text-overlap`. Without them every symbol defaults
 *     to declutter mode and icons get dropped whenever a label collides with them.
 *     We mirror `*-overlap: "always"` to `*-allow-overlap: true` so seamark icons
 *     stay visible (= 'obstacle' mode, matching MapLibre's icon-overlap:always).
 *
 *  B. Submarine cables/pipelines. The source style draws them as icons repeated
 *     along the line (symbol-placement:line + symbol-spacing). ol-mapbox-style
 *     places only ONE icon at the line midpoint and ignores symbol-spacing, and
 *     line-pattern renders nothing on lines. So we replace the combined symbol
 *     layer with two `line` layers using line-dasharray, which is fully supported
 *     and oriented along the line.
 *
 *  Note: the remaining icon-on-line layers (TSS arrows, oneway markings, area
 *  boundary markers) are intentionally left as-is and render as a single
 *  (degraded) symbol under ol-mapbox-style.
 */
const fs = require('fs');
const path = require('path');

const STYLES_DIR = path.join(__dirname, '..', 'styles');

// C. Hillshade tuning for ol-mapbox-style's shader.
// olms reads only these 5 hillshade-* paint props (sun elevation 35 and overall
// opacity 0.3 are hard-coded; hillshade-method is ignored). When shadow/accent
// colors are left unset they default to pure black, which looks harsh and muddy.
// We set soft, cool colors for a nicer look. Tweak these to taste:
const HILLSHADE = {
  'hillshade-shadow-color': '#26323f',     // deep cool slate -> more contrast (not flat gray)
  'hillshade-highlight-color': '#ffffff',
  'hillshade-accent-color': '#26323f',     // dark for definition, with a hint of blue (not pure black)
  'hillshade-illumination-direction': 315  // NW light (classic cartographic)
};
// olms scales relief by 5*exaggeration; bump it for more presence.
const HILLSHADE_EXAGGERATION_FACTOR = 1.6;
// olms hard-codes the hillshade opacity at 0.3 (not settable via paint). To get a
// more opaque/contrasty result we render each hillshade layer N times; two stacked
// layers composite to ~0.51. Set to 1 to disable stacking.
const HILLSHADE_STACK = 2;

// Returns the (possibly stacked) tuned hillshade layers, or null for other layers.
function tuneHillshade(layer) {
  if (layer.type !== 'hillshade') return null;
  layer.paint = layer.paint || {};
  for (const [k, v] of Object.entries(HILLSHADE)) {
    if (layer.paint[k] === undefined) layer.paint[k] = v;
  }
  if (typeof layer.paint['hillshade-exaggeration'] === 'number') {
    layer.paint['hillshade-exaggeration'] =
      +(layer.paint['hillshade-exaggeration'] * HILLSHADE_EXAGGERATION_FACTOR).toFixed(3);
  }
  const stack = [layer];
  for (let i = 2; i <= HILLSHADE_STACK; i++) {
    const dup = JSON.parse(JSON.stringify(layer));
    dup.id = `${layer.id}-${i}`;
    stack.push(dup);
  }
  return stack;
}

// Directional line symbols whose single (midpoint) icon must be rotated along the
// line. ol-mapbox-style only rotates a line-placed icon when icon-rotation-alignment
// is exactly "map"; the default "auto" leaves every arrow pointing the same way.
const LINE_ROTATE_LAYERS = new Set(['TSS-separation-lane-arrows']);
function fixLineIconRotation(layer) {
  if (LINE_ROTATE_LAYERS.has(layer.id)) {
    layer.layout = layer.layout || {};
    layer.layout['icon-rotation-alignment'] = 'map';
    return true;
  }
  return false;
}

// A. Mirror new *-overlap onto legacy *-allow-overlap that ol-mapbox-style reads.
function fixOverlap(layer) {
  const lay = layer.layout;
  if (!lay) return;
  for (const kind of ['icon', 'text']) {
    if (lay[`${kind}-overlap`] === 'always' && lay[`${kind}-allow-overlap`] === undefined) {
      lay[`${kind}-allow-overlap`] = true;
    }
  }
}

// B. Replace the combined cables/pipelines symbol layer with two dashed line layers.
function buildCableLineLayers(orig) {
  const base = {
    source: orig.source,
    'source-layer': orig['source-layer'],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
  };
  const width = ['interpolate', ['linear'], ['zoom'], 8, 1, 14, 2.5];
  return [
    {
      ...base,
      id: 'cables',
      type: 'line',
      filter: ['==', ['get', 'type'], 'cable_submarine'],
      paint: {
        'line-color': '#b3338a',
        'line-width': width,
        'line-opacity': 0.7,
        'line-dasharray': [2, 3],
      },
    },
    {
      ...base,
      id: 'pipelines',
      type: 'line',
      filter: ['==', ['get', 'type'], 'pipeline_submarine'],
      paint: {
        'line-color': '#b3338a',
        'line-width': width,
        'line-opacity': 0.7,
        'line-dasharray': [8, 3, 1, 3],
      },
    },
  ];
}

function transform(style, name) {
  const out = JSON.parse(JSON.stringify(style));
  out.name = name;

  const layers = [];
  let cablesReplaced = 0;
  let overlapFixed = 0;
  let hillshadeTuned = 0;
  for (const layer of out.layers) {
    if (layer.id === 'cables-pipes') {
      layers.push(...buildCableLineLayers(layer));
      cablesReplaced++;
      continue;
    }
    if (layer.type === 'symbol') {
      const before = JSON.stringify(layer.layout);
      fixOverlap(layer);
      fixLineIconRotation(layer);
      if (JSON.stringify(layer.layout) !== before) overlapFixed++;
    }
    const tunedHillshade = tuneHillshade(layer);
    if (tunedHillshade) {
      layers.push(...tunedHillshade);
      hillshadeTuned++;
      continue;
    }
    layers.push(layer);
  }
  out.layers = layers;
  return { out, cablesReplaced, overlapFixed, hillshadeTuned };
}

const variants = [
  { src: 'seamap.json', dst: 'seamap-ol.json', name: 'seamap-ol' },
  { src: 'slim.json', dst: 'seamap-ol-slim.json', name: 'seamap-ol-slim' },
];

for (const v of variants) {
  const style = JSON.parse(fs.readFileSync(path.join(STYLES_DIR, v.src), 'utf8'));
  const { out, cablesReplaced, overlapFixed, hillshadeTuned } = transform(style, v.name);
  fs.writeFileSync(path.join(STYLES_DIR, v.dst), JSON.stringify(out, null, 2) + '\n');
  console.log(
    `${v.src} -> ${v.dst}: ${out.layers.length} layers, ` +
    `overlap-fixed symbols: ${overlapFixed}, cables-pipes replaced: ${cablesReplaced}, ` +
    `hillshade layers tuned: ${hillshadeTuned}`
  );
}

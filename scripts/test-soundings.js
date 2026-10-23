#!/usr/bin/env node
/*
 * Diagnostics for the spot soundings LOD (src/soundings.js).
 *
 *   node scripts/test-soundings.js [lon] [lat] [provider]
 *
 * Generates soundings tiles directly (no cache) around a position, for every zoom from the
 * provider's soundings minzoom to 13, and checks:
 *  A. Zoom consistency: just below z+1 a parent tile shows exactly the soundings its four
 *     children show at z+1 (same positions and depths) → nothing jumps at tile changes.
 *  B. Overlaps: visible label boxes (3x3 tile block) never overlap at sampled zooms.
 *  C. Shoal bias: share of hidden soundings that are shoaler than a visible one nearby.
 *  D. Distribution: nearest neighbour distance (px) and its coefficient of variation
 *     (~0 = grid, ~0.3 = blue noise, ~0.52 = random).
 *  E. Generation time per tile.
 *
 * Uses the plugin options from ~/.signalk/plugin-config-data/signalk-seamap-plugin.json
 * (DEM tiles are read from / cached in its tilesPath like the plugin does).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Pbf = require('pbf').default;
const { VectorTile } = require('@mapbox/vector-tile');
const Pmtiles = require('../src/pmtiles');
const Tiles = require('../src/tiles');
const Contours = require('../src/contours');
const Soundings = require('../src/soundings');
const { labelWidth, LABEL_HEIGHT, DISPLAY_TILE_PX } = Soundings.internals;

const [lon = 14.45, lat = 44.55] = process.argv.slice(2, 4).map(Number);
const provider = process.argv[4] || 'gebco';

const configFile = path.join(os.homedir(), '.signalk', 'plugin-config-data', 'signalk-seamap-plugin.json');
const options = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')).configuration : {};
const seamap = { app: { debug: () => {}, error: console.error }, options };
const tiles = new Tiles(seamap, new Pmtiles(seamap));
const soundings = new Soundings(seamap, new Contours(seamap, tiles));

function tileOf(z) {
  const n = 1 << z;
  const r = (lat * Math.PI) / 180;
  return [Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)];
}

const timings = [];
const memo = new Map();
// Points of a tile in world coordinates (0..1).
async function points(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!memo.has(key)) {
    memo.set(key, (async () => {
      const t0 = performance.now();
      const buf = await soundings.generateSoundingsTile(provider, z, x, y);
      timings.push({ z, ms: performance.now() - t0 });
      if (!buf) return [];
      const layer = new VectorTile(new Pbf(new Uint8Array(buf))).layers.soundings;
      const out = [];
      for (let i = 0; layer && i < layer.length; i++) {
        const f = layer.feature(i);
        const [{ x: px, y: py }] = f.loadGeometry()[0];
        out.push({ wx: (x + px / layer.extent) / (1 << z), wy: (y + py / layer.extent) / (1 << z), depth: f.properties.depth, zoom: f.properties.zoom, z });
      }
      return out;
    })());
  }
  return memo.get(key);
}

async function block(z, x, y) {
  const all = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) all.push(...await points(z, x + dx, y + dy));
  return all;
}

const px = (a, b, zoom) => Math.hypot(a.wx - b.wx, a.wy - b.wy) * DISPLAY_TILE_PX * 2 ** zoom;

function overlaps(visible, zoom) {
  const scale = DISPLAY_TILE_PX * 2 ** zoom;
  const sorted = [...visible].sort((a, b) => a.wx - b.wx);
  let count = 0;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const dx = (sorted[j].wx - sorted[i].wx) * scale;
      if (dx > 60) break;
      const dy = Math.abs(sorted[j].wy - sorted[i].wy) * scale;
      if (dx < (labelWidth(sorted[i].depth) + labelWidth(sorted[j].depth)) / 2 - 1 && dy < LABEL_HEIGHT - 1) count++;
    }
  }
  return count;
}

function nearestStats(set, zoom) {
  const d = set.map(p => Math.min(...set.filter(q => q !== p).map(q => px(p, q, zoom))));
  const mean = d.reduce((s, v) => s + v, 0) / d.length;
  const sd = Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length);
  return { mean, cv: sd / mean };
}

(async () => {
  const source = Pmtiles.SOURCES().find(s => s.name === provider);
  const minZoom = Soundings.minZoom(source);
  console.log(`provider ${provider} (DEM z${source.maxzoom}), soundings from z${minZoom} (DEM zoom per tile zoom: ${Array.from({ length: 14 - minZoom + 1 }, (_, i) => Soundings.demZoom(source, minZoom + i)).join(',')}), spacing`, soundings.spacing(), `at ${lon},${lat}\n`);
  console.log('zoom | tile | A mismatches | B overlaps @z,+.5,+.99 | C shoal-bias violations | D nn px (cv) @z+.5 | count');

  for (let z = minZoom; z <= 13; z++) {
    const [x, y] = tileOf(z);
    const parent = await points(z, x, y);
    const kids = [];
    for (let k = 0; k < 4; k++) kids.push(...await points(z + 1, 2 * x + (k & 1), 2 * y + (k >> 1)));

    // A: parent vs children at the boundary z+1 (match by depth and position within 1.5 parent units)
    const tol = 1.5 / 4096 / (1 << z);
    const expected = kids.filter(p => p.zoom < z + 1);
    const matched = new Set();
    let mismatch = 0;
    // At the boundary only membership matters: the parent shows zoom < z+1 just below it,
    // the children show zoom <= z+1 from it (their values below z+1 are all equivalent).
    for (const p of parent) {
      const q = expected.find(c => !matched.has(c) && c.depth === p.depth && Math.abs(c.wx - p.wx) < tol && Math.abs(c.wy - p.wy) < tol);
      if (!q) mismatch++;
      if (q) matched.add(q);
    }
    mismatch += expected.length - matched.size;

    // B / C / D on the 3x3 block around the tile
    const all = await block(z, x, y);
    const b = [0, 0.5, 0.99].map(f => overlaps(all.filter(p => p.zoom <= z + f), z + f));
    const zoom = z + 0.5;
    const visible = all.filter(p => p.zoom <= zoom);
    const hidden = parent.filter(p => p.zoom > zoom);
    let violations = 0;
    for (const h of hidden) {
      const near = visible.filter(v => px(v, h, zoom) < soundings.spacingFor(h.depth) / 2);
      if (near.some(v => v.depth > h.depth + 0.05)) violations++;
    }
    const inTile = visible.filter(p => parent.includes(p));
    const d = inTile.length > 2 ? nearestStats(visible, zoom) : { mean: NaN, cv: NaN };
    const band = Soundings.demZoom(source, z) !== Soundings.demZoom(source, z + 1) ? ' (band change, jumps expected)' : '';
    console.log(`z${z} | ${x}/${y} | ${mismatch} of ${parent.length}${band} | ${b.join(', ')} | ${violations} of ${hidden.length} hidden | ${d.mean.toFixed(1)} (${d.cv.toFixed(2)}) | ${inTile.length}`);
  }

  const byZ = {};
  for (const t of timings) (byZ[t.z] = byZ[t.z] || []).push(t.ms);
  console.log('\nE generation ms (first = incl. DEM load):', Object.entries(byZ).map(([z, v]) =>
    `z${z}: first ${v[0].toFixed(0)}, median ${v.sort((a, b) => a - b)[v.length >> 1].toFixed(0)}`).join(' | '));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

const encodeVectorTile = require('./maplibre-contour/vtpbf.js').default;
const { GeomType } = require('./maplibre-contour/vtpbf.js');
const Pmtiles = require('./pmtiles');

/*
 * Spot soundings with a level of detail that is baked into the tiles.
 *
 * Renderers must not decide which soundings to show: OpenLayers (Freeboard) has no
 * symbol-sort-key and re-declutters every frame, so labels jump. Instead every sounding
 * gets a fixed world position and a single `zoom` attribute (the zoom from which it is
 * shown); the styles filter `["<=", ["get", "zoom"], ["zoom"]]` and never declutter.
 * Zooming therefore only ever adds or removes soundings, nothing moves.
 *
 * Selection follows chart practice (IHO S-4 B-410: shoal biased, denser in shoal water):
 *  - Candidates are the DEM pixels at the source's native zoom N (one per pixel, at a
 *    hashed but world-fixed position inside the pixel) — never finer than the data.
 *  - A quadtree "min pyramid": the representative of a cell is the shoalest of its four
 *    children's representatives. A sounding's level `b` is the coarsest cell it represents,
 *    so the shoalest point of every area is shown first and the sets are nested.
 *  - Level b is shown once its cell is `spacing(depth)` screen px wide: shoal soundings
 *    get a smaller spacing and appear earlier → denser in shoal water.
 *  - Label collisions: a sounding is delayed until it clears every shoaler neighbour that
 *    is already visible (label boxes, not circles). Neighbours are read straight from the
 *    DEM pyramids within a fixed window, so every tile computes identical values.
 *  - Performance vs. stability: a tile may read at most the 2x2 DEM tiles of the next zoom
 *    (plus margin). Below N-1 the DEM overviews are used instead, in bands of two zooms
 *    (N-2 for tiles N-3..N-2, N-4 for N-5..N-4, ...). Soundings are stable within a band
 *    and may jump where bands meet (GEBCO 7→8, EMODnet 7→8 and 9→10).
 */

// Bump when the selection changes so cached soundings/composite tiles are regenerated.
const ALGORITHM_VERSION = 3;
// Soundings are offered from this zoom (with DEM overviews below the native zoom).
const MIN_ZOOM = 6;
const EXTENT = 4096;
// MapLibre and ol-mapbox-style both render the composite on a 512px tile grid.
const DISPLAY_TILE_PX = 512;
const MAX_TILE_ZOOM = 14;
// Depths at or below this are not labelled (matches the styles' filter).
const MIN_DEPTH = 0.1;
// Soundings at or below this depth are labelled with one decimal (spot_soundings_shallow).
const SHALLOW_DEPTH = 5;
// Spacing is interpolated (log) between these depths: shallow spacing below, deep above.
const SPACING_DEPTHS = [2, 30];
// Label footprint used for collision checks, in screen px (Noto Sans, text-size <= 10).
const CHAR_PX = 6.5;
const LABEL_PAD_X = 3;
const LABEL_HEIGHT = 16;
const MAX_LABEL_WIDTH = 6 * CHAR_PX + 2 * LABEL_PAD_X;
const PYRAMID_CACHE_SIZE = 40;

function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// Jitter inside the DEM pixel, world-fixed: [0.15, 0.85) so neighbours never coincide.
function jitter(gx, gy, seed) {
  return 0.15 + 0.7 * ((hash2(gx, gy, seed) & 0xffff) / 0x10000);
}

function labelText(depth) {
  return depth <= SHALLOW_DEPTH ? String(Math.round(depth * 10) / 10) : String(Math.round(depth));
}

function labelWidth(depth) {
  return labelText(depth).length * CHAR_PX + 2 * LABEL_PAD_X;
}

// Shoaler wins; ties are broken by a world-fixed hash.
function isShoaler(a, b) {
  return a.depth < b.depth || (a.depth === b.depth && a.rank < b.rank);
}

class Soundings {
  constructor(seamap, contours) {
    this.seamap = seamap;
    this.contours = contours;
    this.pyramidCache = new Map();
  }

  spacing() {
    const options = this.seamap.options || {};
    return {
      shallow: Number(options.soundingsShallowSpacing) || 32,
      deep: Number(options.soundingsDeepSpacing) || 64
    };
  }

  // Cache namespace: changes whenever the selection algorithm or its settings change.
  cacheName(name) {
    const { shallow, deep } = this.spacing();
    return `${name}-v${ALGORITHM_VERSION}-${shallow}-${deep}`;
  }

  static source(name) {
    return Pmtiles.SOURCES().find(s => s.name === name);
  }

  static minZoom() {
    return MIN_ZOOM;
  }

  // DEM zoom the soundings of tile z are selected from: the native zoom from N-1 up,
  // below that the overview two zooms down per band, so a tile never needs more than the
  // 2x2 DEM tiles of the next zoom.
  static demZoom(source, z) {
    const n = source.maxzoom;
    return z >= n - 1 ? n : n - 2 * Math.ceil((n - 1 - z) / 2);
  }

  spacingFor(depth) {
    const { shallow, deep } = this.spacing();
    const [d0, d1] = SPACING_DEPTHS;
    const t = Math.min(1, Math.max(0, Math.log(depth / d0) / Math.log(d1 / d0)));
    return shallow * Math.pow(deep / shallow, t);
  }

  /**
   * Min pyramid of one native DEM tile: per pixel its depth and the coarsest level it
   * represents (-1 = no sounding, 0 = only itself, log2(width) = shoalest of the tile).
   */
  nativePyramid(name, n, x, y) {
    const key = `${this.cacheName(name)}/${n}/${x}/${y}`;
    let entry = this.pyramidCache.get(key);
    if (entry) {
      // refresh LRU position
      this.pyramidCache.delete(key);
      this.pyramidCache.set(key, entry);
      return entry;
    }
    entry = this.buildNativePyramid(name, n, x, y).catch(() => null);
    this.pyramidCache.set(key, entry);
    if (this.pyramidCache.size > PYRAMID_CACHE_SIZE) {
      this.pyramidCache.delete(this.pyramidCache.keys().next().value);
    }
    return entry;
  }

  async buildNativePyramid(name, n, x, y) {
    const tile = await this.contours.loadTerrainTile(name, n, x, y);
    if (!tile) return null;

    const w = tile.width;
    const depth = new Float32Array(w * w);
    const level = new Int8Array(w * w).fill(-1);
    let reps = new Int32Array(w * w);

    for (let py = 0; py < w; py++) {
      for (let px = 0; px < w; px++) {
        const i = py * w + px;
        const d = -tile.get(px, py);
        depth[i] = d;
        if (d > MIN_DEPTH) {
          level[i] = 0;
          reps[i] = i;
        } else {
          reps[i] = -1;
        }
      }
    }

    // Ranks are recomputed on demand (cheaper than keeping a w*w array per cached tile).
    const rank = (i) => hash2(x * w + (i % w), y * w + Math.floor(i / w), 1);
    const better = (a, b) => depth[a] < depth[b] || (depth[a] === depth[b] && rank(a) < rank(b));
    for (let size = w, k = 1; size > 1; size >>= 1, k++) {
      const half = size >> 1;
      const next = new Int32Array(half * half);
      for (let cy = 0; cy < half; cy++) {
        for (let cx = 0; cx < half; cx++) {
          let best = -1;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const c = reps[(2 * cy + dy) * size + 2 * cx + dx];
              if (c >= 0 && (best < 0 || better(c, best))) best = c;
            }
          }
          next[cy * half + cx] = best;
          if (best >= 0) level[best] = k;
        }
      }
      reps = next;
    }

    // Zoom from which each candidate shows before label collisions. The shoalest of the
    // whole native tile may represent even coarser cells, but it already shows below the
    // soundings minzoom, so its level within this tile is sufficient.
    const appear = new Float32Array(w * w);
    for (let i = 0; i < w * w; i++) {
      if (level[i] >= 0) appear[i] = this.appearZoom(n, w, level[i], depth[i]);
    }

    return { w, n, x, y, depth, level, appear };
  }

  // Zoom from which a sounding of level b shows: its cell is spacing(depth) px wide.
  appearZoom(n, w, b, depth) {
    return n - b + Math.log2(this.spacingFor(depth) * w / DISPLAY_TILE_PX);
  }

  /**
   * Generate soundings tile
   */
  async generateSoundingsTile(name, z, x, y) {
    const source = Soundings.source(name);
    if (!source || z < Soundings.minZoom()) return null;
    const n = Soundings.demZoom(source, z);

    const span = z < n ? 1 << (n - z) : 1;
    const first = await this.nativePyramid(name, n, z < n ? x * span : x >> (z - n), z < n ? y * span : y >> (z - n));
    const w = first?.w || DISPLAY_TILE_PX;
    // DEM px covered by one screen px at zoom z, by the tile and by the world.
    const demPerPx = Math.pow(2, n - z) * w / DISPLAY_TILE_PX;
    const tileDem = DISPLAY_TILE_PX * demPerPx;
    const worldDem = (1 << n) * w;
    const x0 = x * tileDem;
    const y0 = y * tileDem;

    // Neighbours further than a label box at zoom z can only delay a sounding to a zoom
    // below this tile's range, where it is shown anyway.
    const mx = MAX_LABEL_WIDTH * demPerPx;
    const my = LABEL_HEIGHT * demPerPx;

    // Native DEM tiles covering the tile plus that margin.
    const natives = new Map();
    const loads = [];
    const ny0 = Math.max(0, Math.floor((y0 - my) / w));
    const ny1 = Math.min((1 << n) - 1, Math.floor((y0 + tileDem + my) / w));
    for (let ny = ny0; ny <= ny1; ny++) {
      for (let nx = Math.floor((x0 - mx) / w); nx <= Math.floor((x0 + tileDem + mx) / w); nx++) {
        const wx = ((nx % (1 << n)) + (1 << n)) % (1 << n);
        const key = wx * 65536 + ny;
        if (!natives.has(key)) {
          natives.set(key, null);
          loads.push(this.nativePyramid(name, n, wx, ny).then(p => natives.set(key, p)));
        }
      }
    }
    await Promise.all(loads);

    // Candidate at global DEM pixel (gx, gy), or null.
    const leaf = (gx, gy) => {
      if (gy < 0 || gy >= worldDem) return null;
      const ux = ((gx % worldDem) + worldDem) % worldDem;
      const p = natives.get(Math.floor(ux / w) * 65536 + Math.floor(gy / w));
      if (!p) return null;
      const i = (gy - p.y * w) * w + (ux - p.x * w);
      if (p.level[i] < 0) return null;
      return { gx: gx + jitter(ux, gy, 2), gy: gy + jitter(ux, gy, 3), depth: p.depth[i], rank: hash2(ux, gy, 1), a: p.appear[i] };
    };

    const features = [];
    const zMax = z < MAX_TILE_ZOOM ? z + 1 : Infinity;
    for (let gy = y0; gy < y0 + tileDem; gy++) {
      for (let gx = x0; gx < x0 + tileDem; gx++) {
        const p = leaf(gx, gy);
        if (!p || p.a >= zMax) continue;

        // Delay until clear of every shoaler candidate that is already showing.
        let a = p.a;
        const wp = labelWidth(p.depth);
        for (let qy = Math.floor(p.gy - my); qy <= Math.floor(p.gy + my); qy++) {
          for (let qx = Math.floor(p.gx - mx); qx <= Math.floor(p.gx + mx); qx++) {
            if (qx === gx && qy === gy) continue;
            const q = leaf(qx, qy);
            if (!q || !isShoaler(q, p)) continue;
            const dx = Math.abs(q.gx - p.gx) / demPerPx;
            const dy = Math.abs(q.gy - p.gy) / demPerPx;
            // Zoom from which the two label boxes are apart on at least one axis.
            const zx = dx > 0 ? z + Math.log2((wp + labelWidth(q.depth)) / 2 / dx) : Infinity;
            const zy = dy > 0 ? z + Math.log2(LABEL_HEIGHT / dy) : Infinity;
            const separate = Math.min(zx, zy);
            if (separate > a && q.a < separate) a = separate;
          }
          if (a >= zMax) break;
        }
        const zoom = Math.ceil(a * 100) / 100;
        if (zoom >= zMax) continue;

        features.push({
          type: GeomType.POINT,
          geometry: [[
            Math.floor(((p.gx - x0) / tileDem) * EXTENT),
            Math.floor(((p.gy - y0) / tileDem) * EXTENT)
          ]],
          properties: {
            depth: Math.round(p.depth * 10) / 10,
            zoom
          }
        });
      }
    }

    if (!features.length) return null;

    const pbf = encodeVectorTile({
      extent: EXTENT,
      layers: {
        soundings: {
          features
        }
      }
    });

    return Buffer.from(pbf);
  }

  /**
   * Get soundings tile (unified interface like tiles.getTile)
   * Returns { timestamp, data: Buffer } or null
   */
  async getTile(name, z, x, y) {
    const zNum = parseInt(z);
    const xNum = parseInt(x);
    const yNum = parseInt(y);

    if (isNaN(zNum) || isNaN(xNum) || isNaN(yNum)) {
      return null;
    }

    const source = Soundings.source(name);
    if (!source || zNum < Soundings.minZoom()) {
      return null;
    }

    // Check cache first
    const cacheName = this.cacheName(name);
    let cachedTile = this.contours.tiles.getCachedTile('soundings', cacheName, zNum, xNum, yNum);
    const demZ = Math.min(zNum, source.maxzoom);
    const shift = zNum - demZ;
    let sourceTile = await this.contours.tiles.getTile(name, demZ, xNum >> shift, yNum >> shift).catch(() => null);

    // Regenerate if cache is missing or source is newer
    if (!cachedTile || (sourceTile?.timestamp > cachedTile.timestamp)) {
      const tileData = await this.generateSoundingsTile(name, zNum, xNum, yNum);

      if (!tileData) {
        return null;
      }

      // Save to cache
      this.contours.tiles.saveTileToCache('soundings', cacheName, zNum, xNum, yNum, tileData);

      return {
        timestamp: Date.now(),
        data: tileData
      };
    }

    return {
      timestamp: cachedTile.timestamp,
      data: cachedTile.data()
    };
  }

  async deliverTileJSON(req, res) {
    const { name } = req.params;

    // Verify source exists
    const source = Soundings.source(name);
    if (!source) {
      return res.status(404).send('Source not found');
    }

    res.set('Content-Type', 'application/json');
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({
      tilejson: '3.0.0',
      name: `${name}-soundings`,
      description: `Spot soundings for ${name}`,
      version: '1.0.0',
      attribution: source.attribution || '',
      scheme: 'xyz',
      tiles: [`${req.query.base_url || ''}/plugins/signalk-seamap-plugin/soundings/${name}/{z}/{x}/{y}.pbf`],
      minzoom: Soundings.minZoom(),
      maxzoom: 14,
      bounds: [-180, -85, 180, 85],
      center: [0, 0, 1],
      format: 'pbf',
      vector_layers: [{
        id: 'soundings',
        fields: {
          depth: 'Number',
          zoom: 'Number'
        }
      }]
    });
  }

  async deliverTile(req, res) {
    const { name, z, x, y } = req.params;

    const tile = await this.getTile(name, z, x, y);

    if (!tile) {
      return res.status(204).send();
    }

    res.set('Content-Type', 'application/x-protobuf');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(tile.data);
  }

  middleware(router) {
    router.get('/soundings/:name.json', this.deliverTileJSON.bind(this));
    router.get('/soundings/:name/:z/:x/:y.pbf', this.deliverTile.bind(this));
    return router;
  }
}

module.exports = Soundings;
module.exports.internals = { hash2, labelText, labelWidth, LABEL_HEIGHT, DISPLAY_TILE_PX, MAX_TILE_ZOOM };

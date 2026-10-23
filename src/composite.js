const Pmtiles = require('./pmtiles');
const Pbf = require('pbf').default;
const { VectorTile } = require('@mapbox/vector-tile');
const encodeVectorTile = require('./maplibre-contour/vtpbf.js').default;

// Even-odd point-in-polygon over all rings of a feature (flat [x0, y0, x1, y1, ...] rings),
// so holes (islands) are excluded.
function pointInRings(px, py, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * Composite class combines multiple vector tile sources into a single tile
 * Merges OSM, Seamap, Contours, Bathymetry and Soundings into one PBF
 */
class Composite {
  constructor(seamap, tiles, contours, bathymetry, soundings) {
    this.seamap = seamap;
    this.tiles = tiles;
    this.contours = contours;
    this.bathymetry = bathymetry;
    this.soundings = soundings;
  }

  // The source-layers present in the composite: OSM base (Shortbread schema) plus the
  // plugin's own seamap, contour, bathymetry and soundings layers. Used by the tilejson
  // (`vector_layers`) so the vector-tile inspector page can enumerate them.
  static VECTOR_LAYERS() {
    return [
      // OSM / Shortbread base
      'water_polygons', 'water_lines', 'water', 'land', 'sites', 'buildings',
      'streets', 'street_polygons', 'street_labels', 'bridges', 'ferries',
      'pier_polygons', 'pier_lines', 'dam_polygons', 'dam_lines',
      'boundaries', 'boundary_labels', 'place_labels', 'pois', 'addresses',
      'public_transport', 'aerialways',
      // Plugin-generated / seamap
      'seamark', 'light', 'contours', 'depth_areas', 'depth_contours', 'soundings'
    ];
  }

  /**
   * Generate composite tile by combining all sub-tiles
   */
  async generateCompositeTile(provider, z, x, y) {
    const zNum = parseInt(z);
    const xNum = parseInt(x);
    const yNum = parseInt(y);

    // Load all tiles in parallel
    const [osmTile, seamapTile, contourTile, bathymetryTile, soundingsTile] = await Promise.all([
      this.tiles.getTile('osm', zNum, xNum, yNum).catch(() => null),
      this.tiles.getTile('seamap', zNum, xNum, yNum).catch(() => null),
      this.contours.getTile('mapterhorn', zNum, xNum, yNum).catch(() => null),
      this.bathymetry.getTile(provider, zNum, xNum, yNum).catch(() => null),
      this.soundings.getTile(provider, zNum, xNum, yNum).catch(() => null)
    ]);

    // Decode and merge tiles
    const mergedLayers = {};
    const tiles = [osmTile, seamapTile, contourTile, bathymetryTile, soundingsTile];

    for (const tile of tiles) {
      if (!tile?.data) continue;
      const vt = new VectorTile(new Pbf(new Uint8Array(tile.data)));

      for (const layerName in vt.layers) {
        const layer = vt.layers[layerName];
        if (!mergedLayers[layerName]) mergedLayers[layerName] = [];

        for (let i = 0; i < layer.length; i++) {
          const feature = layer.feature(i);
          const props = {};
          for (const key in feature.properties) {
            const val = feature.properties[key];
            if (typeof val === 'number' && (val > 2147483647 || val < -2147483648)) continue;
            props[key] = val;
          }
          mergedLayers[layerName].push({
            type: feature.type,
            geometry: feature.loadGeometry().map(ring => ring.flatMap(p => [p.x, p.y])),
            properties: props
          });
        }
      }
    }

    // The bathymetry DEMs are coarse (GEBCO ~450m) and report water below islands and
    // towns. Drop soundings on the coastline land polygons (seamap `land` without `kind`,
    // the same polygons the styles draw as land).
    if (mergedLayers.soundings && mergedLayers.land) {
      const land = mergedLayers.land.filter(f => f.type === 3 && f.properties.kind === undefined);
      mergedLayers.soundings = mergedLayers.soundings.filter(f => {
        const [px, py] = f.geometry[0];
        return !land.some(l => pointInRings(px, py, l.geometry));
      });
    }

    if (Object.keys(mergedLayers).length === 0) return null;

    // Re-encode
    const pbf = encodeVectorTile({
      extent: 4096,
      layers: Object.fromEntries(
        Object.entries(mergedLayers).map(([name, features]) => [name, { features }])
      )
    });

    return Buffer.from(pbf);
  }

  async deliverCompositeTileJSON(req, res) {
    const { provider } = req.params;

    // Verify provider exists
    const source = Pmtiles.SOURCES().find(s => s.name === provider);
    if (!source) {
      return res.status(404).send('Provider not found');
    }

    res.set('Content-Type', 'application/json');
    // Short-lived: it carries the tile URL version that busts cached tiles.
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      tilejson: '3.0.0',
      name: `${provider}-composite`,
      description: `Composite vector tiles combining OSM, Seamap, Contours, Bathymetry and Soundings`,
      version: '1.0.0',
      attribution: ['© OpenStreetMap contributors', source.attribution || ''].filter(a => a).join(', '),
      scheme: 'xyz',
      // The version busts browser caches when the baked-in soundings change.
      tiles: [`${req.query.base_url || ''}/plugins/signalk-seamap-plugin/composite/${provider}/{z}/{x}/{y}.pbf?v=${encodeURIComponent(this.soundings.cacheName(provider))}`],
      minzoom: 0,
      maxzoom: 14,
      bounds: [-180, -85, 180, 85],
      center: [0, 0, 1],
      format: 'pbf',
      // Source-layers the composite merges together (OSM/Shortbread + seamap + generated).
      // Declared so tooling (the vector-tile inspector page) can enumerate the layers.
      vector_layers: Composite.VECTOR_LAYERS().map(id => ({ id, fields: {} }))
    });
  }

  async deliverCompositeTile(req, res) {
    const { provider, z, x, y } = req.params;
    const zNum = parseInt(z);
    const xNum = parseInt(x);
    const yNum = parseInt(y);

    if (isNaN(zNum) || isNaN(xNum) || isNaN(yNum)) {
      return res.status(400).send('Invalid tile coordinates');
    }

    // Verify provider exists
    const source = Pmtiles.SOURCES().find(s => s.name === provider);
    if (!source) {
      return res.status(404).send('Provider not found');
    }

    // Check cache first (namespaced by the soundings settings, which are baked in)
    const cacheName = this.soundings.cacheName(provider);
    let cachedTile = this.tiles.getCachedTile('composite', cacheName, zNum, xNum, yNum);

    // Check if any source tiles are newer than cached composite
    const [osmSource, seamapSource, contourSource, bathymetrySource, soundingsSource] = await Promise.all([
      this.tiles.getTile('osm', zNum, xNum, yNum).catch(() => null),
      this.tiles.getTile('seamap', zNum, xNum, yNum).catch(() => null),
      this.contours.getTile('mapterhorn', zNum, xNum, yNum).catch(() => null),
      this.bathymetry.getTile(provider, zNum, xNum, yNum).catch(() => null),
      this.soundings.getTile(provider, zNum, xNum, yNum).catch(() => null)
    ]);

    const maxSourceTimestamp = Math.max(
      osmSource?.timestamp || 0,
      seamapSource?.timestamp || 0,
      contourSource?.timestamp || 0,
      bathymetrySource?.timestamp || 0,
      soundingsSource?.timestamp || 0
    );

    const shouldRegenerate = !cachedTile || maxSourceTimestamp > cachedTile.timestamp;

    let tileData = null;
    if (shouldRegenerate) {
      // Generate new composite tile
      tileData = await this.generateCompositeTile(provider, zNum, xNum, yNum);

      if (!tileData) {
        return res.status(204).send();
      }

      // Save to cache
      this.tiles.saveTileToCache('composite', cacheName, zNum, xNum, yNum, tileData);
    } else {
      tileData = cachedTile.data();
    }

    res.set('Content-Type', 'application/x-protobuf');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(tileData);
  }

  middleware(router) {
    router.get('/composite/:provider.json', this.deliverCompositeTileJSON.bind(this));
    router.get('/composite/:provider/:z/:x/:y.pbf', this.deliverCompositeTile.bind(this));
    return router;
  }
}

module.exports = Composite;

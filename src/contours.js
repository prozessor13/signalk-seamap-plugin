const { HeightTile } = require('./maplibre-contour/height_tile.js');
const generateIsolines = require('./maplibre-contour/isolines.js').default;
const encodeVectorTile = require('./maplibre-contour/vtpbf.js').default;
const { GeomType } = require('./maplibre-contour/vtpbf.js');
const Pmtiles = require('./pmtiles');

class Contours {
  constructor(seamap, tiles) {
    this.seamap = seamap;
    this.tiles = tiles;
  }

  /**
   * Decode terrain RGB tile to height data
   * Supports Terrarium encoding: (R * 256 + G + B / 256) - 32768
   */
  decodeTerrainRGB(imageData, width, height, encoding = 'terrarium') {
    const pixels = width * height;
    const elevations = new Float32Array(pixels);

    for (let i = 0; i < pixels; i++) {
      const r = imageData[i * 4];
      const g = imageData[i * 4 + 1];
      const b = imageData[i * 4 + 2];

      if (encoding === 'terrarium') {
        elevations[i] = r * 256 + g + b / 256 - 32768;
      } else {
        // Mapbox encoding: -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)
        elevations[i] = -10000 + ((r * 256 * 256 + g * 256 + b) * 0.1);
      }
    }

    return elevations;
  }

  /**
   * Load and decode a terrain tile
   */
  async loadTerrainTile(name, z, x, y) {
    const tile = await this.tiles.getTile(name, z, x, y);
    if (!tile) {
      return null;
    }

    // Decode image (WebP or PNG)
    const sharp = require('sharp');
    const image = sharp(tile.data);
    // Ensure we get RGBA format (4 channels) for consistent decoding
    const { data, info } = await image
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Get encoding from source config
    const sourceConfig = Pmtiles.SOURCES().find(s => s.name === name);
    const encoding = sourceConfig?.encoding || 'terrarium';

    const elevations = this.decodeTerrainRGB(data, info.width, info.height, encoding);

    return HeightTile.fromRawDem({
      data: elevations,
      width: info.width,
      height: info.height
    });
  }

  /**
   * Load a single DEM tile with overzoom support (with caching)
   * Similar to fetchDem in local-dem-manager.ts
   * @param {number} overzoom - Number of zoom levels to go down (0 = same zoom, 1 = one zoom level lower)
   */
  async loadDemTile(name, z, x, y, overzoom = 0) {
    // Get source maxzoom
    const sourceConfig = Pmtiles.SOURCES().find(s => s.name === name);
    const maxzoom = sourceConfig?.maxzoom || 14;

    // Calculate actual zoom to fetch
    const zoom = Math.min(z - overzoom, maxzoom);
    const subZ = z - zoom;
    const div = 1 << subZ;
    const newX = Math.floor(x / div);
    const newY = Math.floor(y / div);

    // Check cache for the base tile (before splitting)
    const cacheKey = `${name}/${zoom}/${newX}/${newY}`;

    // Initialize cache if it doesn't exist
    if (!this._demTileCache) {
      this._demTileCache = new Map();
    }

    // Check if we already have an in-flight request for this tile
    if (this._demTileCache.has(cacheKey)) {
      const tile = await this._demTileCache.get(cacheKey);

      // Split if needed
      if (subZ > 0 && tile) {
        return tile.split(subZ, x % div, y % div);
      }
      return tile;
    }

    // Create promise for loading the tile and cache it immediately
    const tilePromise = this.loadTerrainTile(name, zoom, newX, newY);
    this._demTileCache.set(cacheKey, tilePromise);

    const tile = await tilePromise;

    if (!tile) {
      // Remove from cache if load failed
      this._demTileCache.delete(cacheKey);
      return null;
    }

    // Split to get the correct sub-tile for the requested position (only if we did overzoom)
    if (subZ > 0) {
      return tile.split(subZ, x % div, y % div);
    }

    return tile;
  }

  /**
   * Load tiles with neighbors for contour generation
   * Similar to fetchContourTile in local-dem-manager.ts
   * @param {number} overzoom - 0 = use same zoom (9 tiles), 1 = use lower zoom (9 tiles at z-1)
   */
  async loadHeightTileWithNeighbors(name, z, x, y, overzoom = 1) {
    const max = 1 << z;
    const neighborPromises = [];

    // Clear cache before loading new set of tiles
    if (this._demTileCache) {
      this._demTileCache.clear();
    }

    // Load 3x3 grid of neighbors
    for (let iy = y - 1; iy <= y + 1; iy++) {
      for (let ix = x - 1; ix <= x + 1; ix++) {
        // Handle Y boundaries (no wrapping)
        if (iy < 0 || iy >= max) {
          neighborPromises.push(Promise.resolve(null));
        } else {
          // Handle X wrapping (wrap around at date line)
          const wrappedX = (ix + max) % max;
          neighborPromises.push(
            this.loadDemTile(name, z, wrappedX, iy, overzoom)
          );
        }
      }
    }

    const neighbors = await Promise.all(neighborPromises);

    // Clear cache after loading (keep memory usage low)
    if (this._demTileCache) {
      this._demTileCache.clear();
    }

    // Check if center tile exists (index 4 in 3x3 grid)
    if (!neighbors[4]) {
      return null;
    }

    // Replace missing neighbors with empty tiles of same size
    for (let i = 0; i < neighbors.length; i++) {
      if (!neighbors[i] && neighbors[4]) {
        neighbors[i] = HeightTile.fromRawDem({
          data: new Float32Array(neighbors[4].width * neighbors[4].height).fill(0),
          width: neighbors[4].width,
          height: neighbors[4].height
        });
      }
    }

    // Combine all 9 tiles into one virtual tile
    const heightTile = HeightTile.combineNeighbors(neighbors);

    return heightTile;
  }

  /**
   * Generate isolines tile (shared logic for contours and bathymetry)
   */
  async generateIsolinesTile(name, z, x, y, overzoom, layerName, intervalOrLevels) {
    let heightTile = await this.loadHeightTileWithNeighbors(name, z, x, y, overzoom);

    if (!heightTile) {
      return null;
    }

    // Upscale for smoother contours
    const subsampleBelow = 100;

    if (heightTile.width >= subsampleBelow) {
      heightTile = heightTile.materialize(2);
    } else {
      while (heightTile.width < subsampleBelow) {
        heightTile = heightTile.subsamplePixelCenters(2).materialize(2);
      }
    }

    heightTile = heightTile.averagePixelCentersToGrid().materialize(1);

    // Generate isolines using single pass
    const allIsolineSegments = generateIsolines(intervalOrLevels, heightTile, 4096, 1);

    // Convert isolines to vector tile features (maplibre-contour format)
    // This is much more memory-efficient than converting to GeoJSON first
    const features = [];
    const isBathymetry = layerName === 'bathymetry';

    for (const [elevationStr, segments] of Object.entries(allIsolineSegments)) {
      const elevation = parseFloat(elevationStr);

      // Each segment is already in the right format: [x1, y1, x2, y2, ...]
      // Just wrap it in an array for the geometry field
      const properties = {
        elevation: elevation,
        level: Math.round(isBathymetry ? Math.abs(elevation) : elevation)
      };

      if (isBathymetry) {
        properties.depth = Math.abs(elevation);
      }

      features.push({
        type: GeomType.LINESTRING,
        geometry: segments,  // segments is already array of coordinate arrays
        properties
      });
    }

    // Encode directly to MVT/PBF using maplibre-contour's encoder
    // This is the same method maplibre-contour uses internally
    const pbf = encodeVectorTile({
      extent: 4096,
      layers: {
        [layerName]: {
          features
        }
      }
    });

    return Buffer.from(pbf);
  }

  /**
   * Generate contour tile with dynamic intervals
   */
  async generateContourTile(name, z, x, y, overzoom = 1) {
    const interval = this.getContourInterval(z);
    return this.generateIsolinesTile(name, z, x, y, overzoom, 'contours', interval);
  }

  /**
   * Generate bathymetry tile with fixed depth levels
   */
  async generateBathymetryTile(name, z, x, y, overzoom = 1) {
    const depthLevels = this.getBathymetryDepthLevels();
    // Convert to negative elevations (below sea level)
    const elevations = depthLevels.map(depth => -Math.abs(depth));
    return this.generateIsolinesTile(name, z, x, y, overzoom, 'bathymetry', elevations);
  }

  /**
   * Get contour interval based on zoom level (returns single number for interval-based generation)
   */
  getContourInterval(z) {
    if (z >= 14) return 10;
    if (z >= 13) return 20;
    if (z >= 12) return 50;
    if (z >= 10) return 100;
    if (z >= 8) return 200;
    return 500;
  }

  /**
   * Get bathymetry depth levels from config
   */
  getBathymetryDepthLevels() {
    const defaultLevels = [2, 5, 10, 20, 50];

    if (!this.seamap.options?.bathymetryDepthLevels) {
      return defaultLevels;
    }

    const levelsString = this.seamap.options.bathymetryDepthLevels;
    if (typeof levelsString === 'string') {
      return levelsString.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
    }

    return defaultLevels;
  }

  async deliverContourTileJSON(req, res) {
    const { name } = req.params;

    // Verify source exists
    const source = Pmtiles.SOURCES().find(s => s.name === name);
    if (!source) {
      return res.status(404).send('Source not found');
    }

    res.set('Content-Type', 'application/json');
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({
      tilejson: '3.0.0',
      name: `${name}-contours`,
      description: `Contour lines for ${name}`,
      version: '1.0.0',
      attribution: source.attribution || '',
      scheme: 'xyz',
      tiles: [`${req.query.base_url || ''}/plugins/signalk-seamap-plugin/contours/${name}/{z}/{x}/{y}.pbf`],
      minzoom: source.minzoom,
      maxzoom: 14,
      bounds: [-180, -85, 180, 85],
      center: [0, 0, 1],
      format: 'pbf',
      vector_layers: [{
        id: 'contours',
        fields: {
          elevation: 'Number',
          level: 'Number'
        }
      }]
    });
  }

  async deliverContourTile(req, res) {
    const { name, z, x, y } = req.params;
    const zNum = parseInt(z);
    const xNum = parseInt(x);
    const yNum = parseInt(y);

    if (isNaN(zNum) || isNaN(xNum) || isNaN(yNum)) {
      return res.status(400).send('Invalid tile coordinates');
    }

    // Check cache first
    let tile = this.tiles.getCachedTile('contours', name, zNum, xNum, yNum);
    let source = this.tiles.getTile(name, zNum, xNum, yNum);

    let tileData = null;
    if (!tile || source?.timestamp > tile.timestamp) {
      // Generate tile
      tileData = await this.generateContourTile(name, zNum, xNum, yNum);

      if (!tileData) {
        return res.status(204).send();
      }

      // Save to cache
      this.tiles.saveTileToCache('contours', name, zNum, xNum, yNum, tileData);
    } else {
      tileData = tile.data();
    }

    res.set('Content-Type', 'application/x-protobuf');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(tileData);
  }

  async deliverBathymetryTileJSON(req, res) {
    const { name } = req.params;

    // Verify source exists
    const source = Pmtiles.SOURCES().find(s => s.name === name);
    if (!source) {
      return res.status(404).send('Source not found');
    }

    res.set('Content-Type', 'application/json');
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({
      tilejson: '3.0.0',
      name: `${name}-bathymetry`,
      description: `Bathymetry depth contours for ${name}`,
      version: '1.0.0',
      attribution: source.attribution || '',
      scheme: 'xyz',
      tiles: [`${req.query.base_url || ''}/plugins/signalk-seamap-plugin/bathymetry/${name}/{z}/{x}/{y}.pbf`],
      minzoom: source.minzoom + 1, // because of overzoom=1
      maxzoom: 14,
      bounds: [-180, -85, 180, 85],
      center: [0, 0, 1],
      format: 'pbf',
      vector_layers: [{
        id: 'bathymetry',
        fields: {
          elevation: 'Number',
          depth: 'Number',
          level: 'Number'
        }
      }]
    });
  }

  async deliverBathymetryTile(req, res) {
    const { name, z, x, y } = req.params;
    const zNum = parseInt(z);
    const xNum = parseInt(x);
    const yNum = parseInt(y);

    if (isNaN(zNum) || isNaN(xNum) || isNaN(yNum)) {
      return res.status(400).send('Invalid tile coordinates');
    }

    // Check cache first
    let tile = this.tiles.getCachedTile('bathymetry', name, zNum, xNum, yNum);
    let source = this.tiles.getTile(name, zNum, xNum, yNum);

    let tileData = null;
    if (!tile || source?.timestamp > tile.timestamp) {
      // Generate tile
      tileData = await this.generateBathymetryTile(name, zNum, xNum, yNum);

      if (!tileData) {
        return res.status(204).send();
      }

      // Save to cache
      this.tiles.saveTileToCache('bathymetry', name, zNum, xNum, yNum, tileData);
    } else {
      tileData = tile.data();
    }

    res.set('Content-Type', 'application/x-protobuf');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(tileData);
  }

  middleware(router) {
    router.get('/contours/:name.json', this.deliverContourTileJSON.bind(this));
    router.get('/contours/:name/:z/:x/:y.pbf', this.deliverContourTile.bind(this));
    router.get('/bathymetry/:name.json', this.deliverBathymetryTileJSON.bind(this));
    router.get('/bathymetry/:name/:z/:x/:y.pbf', this.deliverBathymetryTile.bind(this));
    return router;
  }
}

module.exports = Contours;

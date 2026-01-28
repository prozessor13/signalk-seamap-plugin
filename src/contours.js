const fs = require('fs');
const path = require('path');
const { HeightTile } = require('./maplibre-contour/height_tile.js');
const generateIsolines = require('./maplibre-contour/isolines.js').default;
const encodeVectorTile = require('./maplibre-contour/vtpbf.js').default;
const { GeomType } = require('./maplibre-contour/vtpbf.js');

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
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

    // Get encoding from source config
    const Pmtiles = require('./pmtiles');
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
   * Load tiles with overzoom support for better performance
   * @param {number} overzoom - 0 = use same zoom (9 tiles), 1 = use lower zoom (up to 3 tiles)
   */
  async loadHeightTileWithNeighbors(name, z, x, y, overzoom = 1) {
    // Get source maxzoom
    const Pmtiles = require('./pmtiles');
    const sourceConfig = Pmtiles.SOURCES().find(s => s.name === name);
    const maxzoom = sourceConfig?.maxzoom || 14;

    // Calculate actual zoom to fetch
    const fetchZoom = Math.min(z - overzoom, maxzoom);
    const zoomDiff = z - fetchZoom;
    const scale = 1 << zoomDiff;

    // Calculate which tile to fetch at lower zoom
    const fetchX = Math.floor(x / scale);
    const fetchY = Math.floor(y / scale);

    // Calculate position within the fetched tile
    const subX = x % scale;
    const subY = y % scale;

    const max = 1 << fetchZoom;
    const neighborPromises = [];

    // Determine which neighbors we need based on position within tile
    // If we're at the edge, we need neighbors, otherwise we don't
    const needWest = subX === 0;
    const needEast = subX === scale - 1;
    const needNorth = subY === 0;
    const needSouth = subY === scale - 1;

    // Load neighbors in 3x3 grid, but only if needed
    for (let iy = -1; iy <= 1; iy++) {
      for (let ix = -1; ix <= 1; ix++) {
        let tilePromise;

        // Skip tiles we don't need
        if (ix === -1 && !needWest) {
          tilePromise = Promise.resolve(null);
        } else if (ix === 1 && !needEast) {
          tilePromise = Promise.resolve(null);
        } else if (iy === -1 && !needNorth) {
          tilePromise = Promise.resolve(null);
        } else if (iy === 1 && !needSouth) {
          tilePromise = Promise.resolve(null);
        } else {
          // Load the tile
          const tileX = (fetchX + ix + max) % max;
          const tileY = fetchY + iy;

          // Clamp Y coordinate
          if (tileY < 0 || tileY >= max) {
            tilePromise = Promise.resolve(null);
          } else {
            tilePromise = this.loadTerrainTile(name, fetchZoom, tileX, tileY);
          }
        }

        neighborPromises.push(tilePromise);
      }
    }

    console.log("load tiles", neighborPromises.length);
    const neighbors = await Promise.all(neighborPromises);

    // Check if center tile exists
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

    // Combine neighbors
    let heightTile = HeightTile.combineNeighbors(neighbors);

    // If we fetched a lower zoom tile, split it to get the correct quadrant
    if (zoomDiff > 0 && heightTile) {
      heightTile = heightTile.split(zoomDiff, subX, subY);
    }

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
    // Zoom-dependent intervals (similar to MTK terrain)
    if (z >= 15) return 10;
    if (z >= 14) return 20;
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
    const Pmtiles = require('./pmtiles');
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
      tiles: [
        `${req.protocol}://${req.get('host')}/plugins/signalk-seamap-plugin/contours/${name}/{z}/{x}/{y}.pbf`
      ],
      minzoom: source.minzoom,
      maxzoom: Math.min(source.maxzoom, 14),
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
    if (true || !tile || source?.timestamp > tile.timestamp) {
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
    const Pmtiles = require('./pmtiles');
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
      tiles: [`${req.protocol}://${req.get('host')}/plugins/signalk-seamap-plugin/bathymetry/${name}/{z}/{x}/{y}.pbf`],
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

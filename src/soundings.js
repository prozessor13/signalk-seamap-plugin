const fs = require('fs');
const path = require('path');
const { HeightTile } = require('./maplibre-contour/height_tile.js');
const encodeVectorTile = require('./maplibre-contour/vtpbf.js').default;
const { GeomType } = require('./maplibre-contour/vtpbf.js');

/**
 * Seeded random number generator using Linear Congruential Generator (LCG)
 * Returns a function that generates deterministic pseudo-random numbers between 0 and 1
 */
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * Generate a jittered grid of points across a tile
 * @param {number} minx - Minimum x coordinate
 * @param {number} miny - Minimum y coordinate
 * @param {number} maxx - Maximum x coordinate
 * @param {number} maxy - Maximum y coordinate
 * @param {number} spacing - Grid spacing in tile coordinates
 * @param {number} tileX - Tile X coordinate (for seeding)
 * @param {number} tileY - Tile Y coordinate (for seeding)
 * @param {number} tileZ - Tile Z coordinate (for seeding)
 * @returns {Array<[number, number]>} Array of [x, y] point coordinates
 */
function generateJitteredGrid(minx, miny, maxx, maxy, spacing, tileX, tileY, tileZ) {
  const nx = Math.floor((maxx - minx) / spacing);
  const ny = Math.floor((maxy - miny) / spacing);

  const points = [];

  // Use tile coordinates for seeding to ensure consistent jitter across tiles
  const seed = tileZ * 1000000 + tileX * 1000 + tileY;
  const random = seededRandom(seed);

  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= ny; j++) {
      const dx = (random() * spacing) / 2;
      const dy = (random() * spacing) / 2;
      const x = minx + i * spacing + dx + spacing / 4;
      const y = miny + j * spacing + dy + spacing / 4;
      if (x < maxx && y < maxy) {
        points.push([x, y]);
      }
    }
  }

  return points;
}

class Soundings {
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
   * Load tiles with overzoom support
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

    const neighbors = await Promise.all(neighborPromises);

    // Check if center tile exists
    if (!neighbors[4]) {
      return null;
    }

    // Replace missing neighbors with empty tiles of same size
    for (let i = 0; i < neighbors.length; i++) {
      if (!neighbors[i] && neighbors[4]) {
        neighbors[i] = HeightTile.fromRawDem({
          data: new Float32Array(neighbors[4].width * neighbors[4].height).fill(NaN),
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
   * Generate soundings tile
   */
  async generateSoundingsTile(name, z, x, y, overzoom = 1) {
    let heightTile = await this.loadHeightTileWithNeighbors(name, z, x, y, overzoom);

    if (!heightTile) {
      return null;
    }

    // Upscale for better sampling
    const subsampleBelow = 100;

    if (heightTile.width >= subsampleBelow) {
      heightTile = heightTile.materialize(2);
    } else {
      while (heightTile.width < subsampleBelow) {
        heightTile = heightTile.subsamplePixelCenters(2).materialize(2);
      }
    }

    // Get grid spacing from config (pixels at 512px tile)
    const spotGridSpacing = this.getSoundingsGridSpacing(z);
    const extent = 4096;
    const spacingInExtent = (spotGridSpacing / 512) * extent;

    const gridPoints = generateJitteredGrid(0, 0, extent, extent, spacingInExtent, x, y, z);

    // Sample elevation at each grid point
    const pointFeatures = [];
    const isBathymetry = name.includes('bathymetry') || name.includes('gebco');

    for (const [px, py] of gridPoints) {
      const tileX = Math.floor((px / extent) * heightTile.width);
      const tileY = Math.floor((py / extent) * heightTile.height);

      if (tileX >= 0 && tileX < heightTile.width &&
          tileY >= 0 && tileY < heightTile.height) {
        const elevation = heightTile.get(tileX, tileY);

        // Skip NaN or invalid values
        if (!isNaN(elevation)) {
          const properties = {
            elevation: Math.round(elevation * 10) / 10
          };

          // For bathymetry, add depth property
          if (isBathymetry && elevation < 0) {
            properties.depth = Math.round(Math.abs(elevation) * 10) / 10;
          }

          pointFeatures.push({
            type: GeomType.POINT,
            geometry: [[px, py]],
            properties
          });
        }
      }
    }

    // Sort by elevation (descending for bathymetry, ascending for terrain)
    const sortOrder = this.getSoundingsSortOrder();
    pointFeatures.sort((a, b) => {
      const eleA = a.properties.elevation;
      const eleB = b.properties.elevation;
      return sortOrder === 'asc' ? eleA - eleB : eleB - eleA;
    });

    // Encode to vector tile
    const pbf = encodeVectorTile({
      extent: extent,
      layers: {
        soundings: {
          features: pointFeatures
        }
      }
    });

    return Buffer.from(pbf);
  }

  /**
   * Get soundings grid spacing based on zoom level (in pixels at 512px tile size)
   */
  getSoundingsGridSpacing(z) {
    // Default spacing based on zoom level
    // Higher zoom = denser grid
    if (z >= 15) return 64;   // ~16 points per tile
    if (z >= 14) return 96;   // ~12 points per tile
    if (z >= 12) return 128;  // ~8 points per tile
    if (z >= 10) return 192;  // ~5 points per tile
    if (z >= 8) return 256;   // ~3 points per tile
    return 384;               // ~2 points per tile
  }

  /**
   * Get soundings sort order from config
   */
  getSoundingsSortOrder() {
    return this.seamap.options?.soundingsSortOrder || 'desc';
  }

  async deliverTileJSON(req, res) {
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
      name: `${name}-soundings`,
      description: `Spot soundings for ${name}`,
      version: '1.0.0',
      attribution: source.attribution || '',
      scheme: 'xyz',
      tiles: [`${req.protocol}://${req.get('host')}/plugins/signalk-seamap-plugin/soundings/${name}/{z}/{x}/{y}.pbf`],
      minzoom: source.minzoom + 1, // because of overzoom=1
      maxzoom: 14,
      bounds: [-180, -85, 180, 85],
      center: [0, 0, 1],
      format: 'pbf',
      vector_layers: [{
        id: 'soundings',
        fields: {
          elevation: 'Number',
          depth: 'Number'
        }
      }]
    });
  }

  async deliverTile(req, res) {
    const { name, z, x, y } = req.params;
    const zNum = parseInt(z);
    const xNum = parseInt(x);
    const yNum = parseInt(y);

    if (isNaN(zNum) || isNaN(xNum) || isNaN(yNum)) {
      return res.status(400).send('Invalid tile coordinates');
    }

    // Check cache first
    let tile = this.tiles.getCachedTile('soundings', name, zNum, xNum, yNum);
    let source = this.tiles.getTile(name, zNum, xNum, yNum);

    let tileData = null
    if (!tile || source?.timestamp > tile.timestamp) {
      // Generate tile
      tileData = await this.generateSoundingsTile(name, zNum, xNum, yNum);

      if (!tileData) {
        return res.status(204).send();
      }

      // Save to cache
      this.tiles.saveTileToCache('soundings', name, zNum, xNum, yNum, tileData);
    } else {
      tileData = tile.data();
    }

    res.set('Content-Type', 'application/x-protobuf');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(tileData);
  }

  middleware(router) {
    router.get('/soundings/:name.json', this.deliverTileJSON.bind(this));
    router.get('/soundings/:name/:z/:x/:y.pbf', this.deliverTile.bind(this));
    return router;
  }
}

module.exports = Soundings;

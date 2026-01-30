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
        points.push([Math.floor(x), Math.floor(y)]);
      }
    }
  }

  return points;
}

class Soundings {
  constructor(seamap, contours) {
    this.seamap = seamap;
    this.contours = contours;
  }

  /**
   * Generate soundings tile
   */
  async generateSoundingsTile(name, z, x, y) {
    let heightTile = await this.contours.loadDemTile(name, z, x, y);
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
    const spotGridSpacing = z >= 14 ? 16 : 32;
    const extent = 4096;
    const spacingInExtent = (spotGridSpacing / 512) * extent;

    const gridPoints = generateJitteredGrid(0, 0, extent, extent, spacingInExtent, x, y, z);

    // Sample elevation at each grid point
    const pointFeatures = [];

    for (const [px, py] of gridPoints) {
      const tileX = Math.floor((px / extent) * heightTile.width);
      const tileY = Math.floor((py / extent) * heightTile.height);

      if (tileX >= 0 && tileX < heightTile.width &&
          tileY >= 0 && tileY < heightTile.height) {
        const elevation = heightTile.get(tileX, tileY);

        // Skip NaN or invalid values
        if (!isNaN(elevation)) {
          const properties = {
            depth: Math.round(Math.abs(elevation) * 10) / 10
          };

          pointFeatures.push({
            type: GeomType.POINT,
            geometry: [[px, py]],
            properties
          });
        }
      }
    }

    pointFeatures.sort((a, b) => a.properties.depth - b.properties.depth);

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
      tiles: [`/plugins/signalk-seamap-plugin/soundings/${name}/{z}/{x}/{y}.pbf`],
      minzoom: source.minzoom + 1, // because of overzoom=1
      maxzoom: 14,
      bounds: [-180, -85, 180, 85],
      center: [0, 0, 1],
      format: 'pbf',
      vector_layers: [{
        id: 'soundings',
        fields: {
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
    let tile = this.contours.tiles.getCachedTile('soundings', name, zNum, xNum, yNum);
    let source = this.contours.tiles.getTile(name, zNum, xNum, yNum);

    tile = null;
    let tileData = null
    if (!tile || source?.timestamp > tile.timestamp) {
      // Generate tile
      tileData = await this.generateSoundingsTile(name, zNum, xNum, yNum);

      if (!tileData) {
        return res.status(204).send();
      }

      // Save to cache
      this.contours.tiles.saveTileToCache('soundings', name, zNum, xNum, yNum, tileData);
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

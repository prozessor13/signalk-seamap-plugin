const Contours = require('./contours');
const generateIsobands = require('./maplibre-contour/isobands.js').default;
const encodeVectorTile = require('./maplibre-contour/vtpbf.js').default;
const { GeomType } = require('./maplibre-contour/vtpbf.js');
const Pmtiles = require('./pmtiles');

/**
 * Bathymetry class extends Contours to generate depth contours
 * Uses isobands (filled polygons) to represent depth ranges
 */
class Bathymetry extends Contours {
  constructor(seamap, tiles) {
    super(seamap, tiles);
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

  /**
   * Generate bathymetry tile with isobands (filled polygons)
   */
  async generateBathymetryTile(name, z, x, y, overzoom = 1) {
    const depthLevels = this.getBathymetryDepthLevels();
    // Convert to negative elevations (below sea level)
    const elevations = depthLevels.map(depth => -Math.abs(depth));
    return this.generateIsobandsTile(name, z, x, y, overzoom, 'bathymetry', elevations);
  }

  /**
   * Generate isobands tile (filled polygons between elevation levels)
   */
  async generateIsobandsTile(name, z, x, y, overzoom, layerName, levels) {
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

    // Generate isobands using marching-squares
    const allIsobandRanges = generateIsobands(levels, heightTile, 4096, 1);

    // Convert isobands to vector tile features (polygons)
    const polygonFeatures = [];
    const lineFeatures = [];

    // Scaling factor to convert tile coordinates back to heightTile coordinates
    const tileToHeightScale = (heightTile.width - 1) / 4096;

    // Track processed lines to avoid duplicates
    const processedLines = new Set();

    for (const [rangeKey, polygons] of Object.entries(allIsobandRanges)) {
      // rangeKey format: "lower:upper" (e.g., "-10:-5")
      const [lowerStr, upperStr] = rangeKey.split(':');
      const lower = parseFloat(lowerStr);
      const upper = parseFloat(upperStr);

      const properties = {
        lower: lower,
        upper: upper,
        depthLower: Math.abs(upper), // upper is less negative (shallower)
        depthUpper: Math.abs(lower), // lower is more negative (deeper)
        depth: Math.abs((lower + upper) / 2), // average depth
        level: Math.round(Math.abs((lower + upper) / 2))
      };

      polygonFeatures.push({
        type: GeomType.POLYGON,
        geometry: polygons, // Array of polygons
        properties
      });

      // Extract all rings from this band and determine which boundary they represent
      for (const polygon of polygons) {
        const lineKey = polygon.join(',');

        // Skip if we've already processed this line
        if (processedLines.has(lineKey)) {
          continue;
        }
        processedLines.add(lineKey);

        // Sample a point on the ring to determine its elevation
        // Use the first point (could also use middle point)
        const sampleX = Math.round(polygon[0] * tileToHeightScale);
        const sampleY = Math.round(polygon[1] * tileToHeightScale);
        const sampledElevation = heightTile.get(sampleX, sampleY);

        // Determine which boundary this ring represents based on sampled elevation
        // The ring is closer to whichever boundary (lower or upper) the sample is closer to
        const distToLower = Math.abs(sampledElevation - lower);
        const distToUpper = Math.abs(sampledElevation - upper);
        const ringElevation = distToLower < distToUpper ? lower : upper;

        // Only create labels for deeper boundaries (exclude shallowest level)
        const sortedLevels = [...levels].sort((a, b) => a - b);
        const isDeepBoundary = ringElevation !== sortedLevels[sortedLevels.length - 1];

        if (isDeepBoundary) {
          const labelProperties = {
            elevation: ringElevation,
            depth: Math.abs(ringElevation),
            level: Math.round(Math.abs(ringElevation))
          };

          lineFeatures.push({
            type: GeomType.LINESTRING,
            geometry: [polygon],
            properties: labelProperties
          });
        }
      }
    }

    // Encode to MVT/PBF with two layers: polygons and labels
    const layers = {
      [layerName]: {
        features: polygonFeatures
      }
    };

    // Add label layer if we have lines
    if (lineFeatures.length > 0) {
      layers[`${layerName}-labels`] = {
        features: lineFeatures
      };
    }

    const pbf = encodeVectorTile({
      extent: 4096,
      layers
    });

    return Buffer.from(pbf);
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
      vector_layers: [
        {
          id: 'bathymetry',
          description: 'Filled polygons for depth ranges',
          fields: {
            lower: 'Number',
            upper: 'Number',
            depthLower: 'Number',
            depthUpper: 'Number',
            depth: 'Number',
            level: 'Number'
          }
        },
        {
          id: 'bathymetry-labels',
          description: 'Contour lines for labeling the deeper boundaries',
          fields: {
            elevation: 'Number',
            depth: 'Number',
            level: 'Number'
          }
        }
      ]
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
    router.get('/bathymetry/:name.json', this.deliverBathymetryTileJSON.bind(this));
    router.get('/bathymetry/:name/:z/:x/:y.pbf', this.deliverBathymetryTile.bind(this));
    return router;
  }
}

module.exports = Bathymetry;

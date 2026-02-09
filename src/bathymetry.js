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
   * Split a polygon ring at tile boundaries (0 and extent)
   * Returns an array of line segments that are within the tile bounds
   * @param {number[]} ring - Flat array of coordinates [x1, y1, x2, y2, ...]
   * @param {number} extent - Tile extent (typically 4096)
   * @returns {number[][]} Array of line segments
   */
  splitRingAtTileBounds(ring, extent) {
    const segments = [];
    let currentSegment = [];

    for (let i = 0; i < ring.length; i += 2) {
      const x = ring[i];
      const y = ring[i + 1];

      // Check if point is within tile bounds
      const isInside = x >= 0 && x <= extent && y >= 0 && y <= extent;

      if (isInside) {
        // Point is inside, add to current segment
        currentSegment.push(x, y);
      } else {
        // Point is outside tile bounds
        if (currentSegment.length > 0) {
          // We were building a segment, close it and start a new one
          segments.push(currentSegment);
          currentSegment = [];
        }
      }
    }

    // Add last segment if it has points
    if (currentSegment.length > 0) {
      segments.push(currentSegment);
    }

    return segments;
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

    // Add levels for shallow areas:
    // - Add level for dry/land areas (above 0m): use a high positive value (100m)
    // - Add 0m level to create polygon from 0 to first depth level
    // Result: [100, 0, -2, -5, -10, ...] creates ranges: 0-100m (land), -2-0m (shallow), -5--2m, etc.
    const extendedElevations = [10000, 0, ...elevations.sort((a, b) => b - a)];

    return this.generateTile(name, z, x, y, overzoom, extendedElevations);
  }

  /**
   * Generate isobands tile (filled polygons between elevation levels)
   */
  async generateTile(name, z, x, y, overzoom, levels) {
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

    for (const [rangeKey, polygons] of Object.entries(allIsobandRanges)) {
      // rangeKey format: "lower:upper:level" (e.g., "-10:-5:2")
      const [lowerStr, upperStr, level] = rangeKey.split(':');
      const lower = parseFloat(lowerStr);
      const upper = parseFloat(upperStr);

      polygonFeatures.push({
        type: GeomType.POLYGON,
        geometry: polygons, // Array of polygons
        properties: {
          depth_min: Math.abs(upper), // upper is less negative (shallower)
          depth_max: Math.abs(lower), // lower is more negative (deeper)
          level: parseInt(level)
        }
      });

      // Extract all rings from this band and split at tile boundaries
      for (const polygon of polygons) {
        // Split ring at tile extent (0-4096) to get segments within the tile
        const segments = this.splitRingAtTileBounds(polygon, 4096);

        for (const segment of segments) {
          // Segment too small (need at least 2 points)
          if (segment.length < 4) continue;

          // Sample the first point of the segment to determine its elevation
          const sampleX = Math.round(segment[0] * tileToHeightScale);
          const sampleY = Math.round(segment[1] * tileToHeightScale);

          // Clamp to valid heightTile bounds to avoid errors
          const clampedX = Math.max(0, Math.min(heightTile.width - 1, sampleX));
          const clampedY = Math.max(0, Math.min(heightTile.height - 1, sampleY));
          const sampledElevation = heightTile.get(clampedX, clampedY);
          if (isNaN(sampledElevation)) continue;

          // Only use segments that are on the deeper side (below the deeper boundary)
          // If sampled elevation is closer to the deeper boundary, this segment represents it
          const distToLower = Math.abs(sampledElevation - lower);
          const distToUpper = Math.abs(sampledElevation - upper);
          if (distToLower < distToUpper) {
            lineFeatures.push({
              type: GeomType.LINESTRING,
              geometry: [segment],
              properties: {
                depth: Math.abs(lower),
              }
            });
          }
        }
      }
    }

    // Encode to MVT/PBF with two layers: polygons and labels
    return Buffer.from(encodeVectorTile({
      extent: 4096,
      layers: {
        depth_areas: { features: polygonFeatures },
        depth_contours: { features: lineFeatures }
      }
    }));
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
          id: 'depth_areas',
          description: 'Filled polygons for depth ranges',
          fields: {
            depth_min: 'Number',
            depth_max: 'Number',
            level: 'Number'
          }
        },
        {
          id: 'depth_contours',
          description: 'Contour lines for labeling the deeper boundaries',
          fields: {
            depth: 'Number'
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

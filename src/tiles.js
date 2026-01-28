const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { PMTiles } = require("pmtiles");

class FileSource {
  constructor(filename) {
    this.filename = filename;
    this.fd = fs.openSync(filename, "r");
  }
  getKey() {
    return this.filename;
  }
  async getBytes(offset, length) {
    const buffer = Buffer.alloc(length);
    await new Promise((resolve, reject) => {
      fs.read(this.fd, buffer, 0, length, offset, (err) => err ? reject(err) : resolve());
    });
    return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
  }
  close() {
    fs.closeSync(this.fd);
  }
}

class PMTilesCache {
  constructor(maxSize = 50) {
    this.maxSize = maxSize;
    this.cache = new Map(); // key: filename, value: { pmtiles, source }
  }

  async get(filePath) {
    if (this.cache.has(filePath)) {
      const value = this.cache.get(filePath);
      this.cache.delete(filePath);
      this.cache.set(filePath, value);
      return value.pmtiles;
    }

    const source = new FileSource(filePath);
    const pmtiles = new PMTiles(source);

    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      const oldest = this.cache.get(oldestKey);
      await oldest.pmtiles.close();
      oldest.source.close();
      this.cache.delete(oldestKey);
    }

    this.cache.set(filePath, { pmtiles, source });
    return pmtiles;
  }

  async closeAll() {
    for (const { pmtiles, source } of this.cache.values()) {
      await pmtiles.close();
      source.close();
    }
    this.cache.clear();
  }
}

class Tiles {
  constructor(seamap, pmtiles) {
    this.seamap = seamap;
    this.pmtiles = pmtiles;
    this.pmtilesCache = new PMTilesCache();
    this.onlinePmtilesCache = {};
    this.isOnline = false;
    this.pendingTiles = new Map(); // key: "name_z_x_y", value: Promise
    this.startConnectivityCheck();
  }

  initializeTileCache() {
    try {
      if (!fs.existsSync(this.seamap.options.tilesPath)) {
        fs.mkdirSync(this.seamap.options.tilesPath, { recursive: true });
      }
    } catch (err) {
      console.error('Error initializing tile cache:', err);
    }
  }

  startConnectivityCheck() {
    // Check connectivity every 10 seconds
    this.checkConnectivity();
    setInterval(() => this.checkConnectivity(), 10000);
  }

  checkConnectivity() {
    const Pmtiles = require('./pmtiles');
    const sources = Pmtiles.SOURCES();

    if (sources.length === 0) {
      this.isOnline = false;
      return;
    }

    // Try to fetch from first source URL
    const testUrl = sources[0].url;

    const urlObj = new URL(testUrl);
    const options = {
      method: 'HEAD',
      host: urlObj.hostname,
      path: urlObj.pathname,
      timeout: 5000
    };

    const protocol = urlObj.protocol === 'https:' ? https : http;

    const req = protocol.request(options, (res) => {
      this.isOnline = res.statusCode >= 200 && res.statusCode < 400;
    });

    req.on('error', () => {
      this.isOnline = false;
    });

    req.on('timeout', () => {
      req.destroy();
      this.isOnline = false;
    });

    req.end();
  }

  getCachedTile(backend, source, z, x, y) {
    if (!this.seamap.options.tilesPath) return null;

    try {
      const tilePath = path.join(this.seamap.options.tilesPath, backend, source, String(z), String(x), String(y));
      if (fs.existsSync(tilePath)) {
        return {
          data: () => fs.readFileSync(tilePath),
          timestamp: fs.statSync(tilePath).mtimeMs
        };
      }
      return null;
    } catch (err) {
      console.error('Error getting cached tile:', err);
      return null;
    }
  }

  saveTileToCache(backend, source, z, x, y, data) {
    if (!this.seamap.options.tilesPath) return;

    try {
      const tilePath = path.join(this.seamap.options.tilesPath, backend, source, String(z), String(x), String(y));
      const tileDir = path.dirname(tilePath);

      if (!fs.existsSync(tileDir)) {
        fs.mkdirSync(tileDir, { recursive: true });
      }

      fs.writeFileSync(tilePath, Buffer.from(data));
    } catch (err) {
      console.error('Error saving tile to cache:', err);
    }
  }

  reduceToZoom(z, x, y, targetZ) {
    const scale = Math.pow(2, z - targetZ);
    return [targetZ, Math.floor(x / scale), Math.floor(y / scale)];
  }

  async getTile(name, z, x, y) {
    const zNum = parseInt(z);
    const xNum = parseInt(x);
    const yNum = parseInt(y);

    // Create unique key for this tile request
    const tileKey = `${name}_${zNum}_${xNum}_${yNum}`;

    // If this tile is already being fetched, wait for the existing request
    if (this.pendingTiles.has(tileKey)) {
      return this.pendingTiles.get(tileKey);
    }

    // Create new fetch promise
    const fetchPromise = this.fetchTile(name, zNum, xNum, yNum).finally(() => {
      // Clean up pending request once complete
      this.pendingTiles.delete(tileKey);
    });

    // Store the promise so other requests can wait for it
    this.pendingTiles.set(tileKey, fetchPromise);

    return fetchPromise;
  }

  /**
   * Internal method to actually fetch tile data
   * @private
   */
  async fetchTile(name, zNum, xNum, yNum) {
    // Get source from SOURCES
    const Pmtiles = require('./pmtiles');
    const source = Pmtiles.SOURCES().find(s => s.name === name);
    if (!source) {
      return null;
    }

    // Check if tile is within zoom range
    if (zNum < source.minzoom || zNum > source.maxzoom) {
      return null;
    }

    // check offline cache
    const cachedTile = this.getCachedTile('tiles', name, zNum, xNum, yNum);
    const cachedTime = cachedTile?.timestamp || 0;
    const pmtilesFile = path.join(this.seamap.options.pmtilesPath, this.reduceToZoom(zNum, xNum, yNum, 6).join("_"), source.output);
    const pmtilesTime = fs.existsSync(pmtilesFile) ? fs.statSync(pmtilesFile).mtimeMs : 0;

    // deliver offline tiles at least for one week #FIXME make configurable
    if (Math.max(cachedTime, pmtilesTime) > Date.now() - 7 * 24 * 3600000) {
      if (pmtilesTime > cachedTime) {
        const pmtiles = await this.pmtilesCache.get(pmtilesFile);
        const tile = await pmtiles.getZxy(zNum, xNum, yNum);
        return { timestamp: pmtilesTime, data: Buffer.from(tile.data) };
      } else {
        return { timestamp: cachedTile.timestamp, data: cachedTile.data() };
      }
    }

    // fetch tile online
    if (source.url) {
      try {
        if (!this.onlinePmtilesCache[source.name]) {
          this.onlinePmtilesCache[source.name] = new PMTiles(source.url);
        }
        const onlineTile = await this.onlinePmtilesCache[source.name].getZxy(zNum, xNum, yNum);
        if (onlineTile) {
          this.saveTileToCache('tiles', name, zNum, xNum, yNum, onlineTile.data);
          return { timestamp: Date.now() , data: Buffer.from(onlineTile.data) };
        }
      } catch (err) {
        console.error('Error fetching tile from online:', err);
      }
    }

    return null;
  }

  async deliverTile(req, res) {
    const { name, z, x, y } = req.params;
    const zNum = parseInt(z);
    const xNum = parseInt(x);
    const yNum = parseInt(y);

    if (isNaN(zNum) || isNaN(xNum) || isNaN(yNum)) {
      return res.status(400).send('Invalid tile coordinates');
    }

    // Get source from SOURCES
    const Pmtiles = require('./pmtiles');
    const source = Pmtiles.SOURCES().find(s => s.name === name);
    if (!source) {
      return res.status(404).send('Source not found');
    }

    // Check if tile is within zoom range
    if (zNum < source.minzoom || zNum > source.maxzoom) {
      return res.status(204).send();
    }

    // Use getTile to fetch the tile
    const tileData = await this.getTile(name, zNum, xNum, yNum);

    if (!tileData) {
      return res.status(204).send();
    }

    res.set('Content-Type', source.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(tileData.data);
  }

  async deliverTileJSON(req, res) {
    const { name } = req.params;

    // Get source from SOURCES
    const Pmtiles = require('./pmtiles');
    const source = Pmtiles.SOURCES().find(s => s.name === name);
    if (!source) {
      return res.status(404).send('Source not found');
    }

    res.set('Content-Type', 'application/json');
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({
      tilejson: '3.0.0',
      name: name,
      description: `Tiles for ${name}`,
      version: '1.0.0',
      attribution: source.attribution || '',
      scheme: 'xyz',
      tiles: [`${req.protocol}://${req.get('host')}/plugins/signalk-seamap-plugin/tiles/${name}/{z}/{x}/{y}.${source.format}`],
      encoding: source.encoding,
      tileSize: source.tileSize,
      minzoom: source.minzoom,
      maxzoom: source.maxzoom,
      bounds: [-180, -85, 180, 85],
      center: [0, 0, 1]
    });
  }

  middleware(router) {
    router.get('/tiles/:name.json', this.deliverTileJSON.bind(this));
    router.get('/tiles/:name/:z/:x/:y.:format', this.deliverTile.bind(this));
    return router;
  }
}

module.exports = Tiles;

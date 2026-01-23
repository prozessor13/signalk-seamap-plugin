const fs = require("fs");
const path = require("path");
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
    return { data: buffer };
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
  }

  reduceToZoom(z, x, y, targetZ) {
    const scale = Math.pow(2, z - targetZ);
    return [targetZ, Math.floor(x / scale), Math.floor(y / scale)];
  }

  readLocalTile(name, z, x, y) {

  }

  getTileJSON(req, res) {
    const fname =
  }

  middleware(router) {
    router.get('/sprites/:name.json', this.getTileJSON.bind(this));
    router.get('/sprites/:name/:z/:x/:y.:format', this.getTile.bind(this));
    return router;
  }
}

module.exports = Tiles;

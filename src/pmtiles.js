const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');

class Pmtiles {
  constructor(seamap) {
    this.seamap = seamap;
    this.state = this.emtpyState();
    this.cache = {};
  }

  static SOURCES() {
    return [
      {
        name: 'seamap',
        url: 'https://fsn1.your-objectstorage.com/mtk-seamap/seamap.pmtiles',
        output: 'seamap.pmtiles',
        minzoom: 0,
        maxzoom: 14,
        format: 'pbf',
        contentType: 'application/x-protobuf',
        attribution: '© OpenSeaMap contributors'
      },
      {
        name: 'osm',
        url: 'https://fsn1.your-objectstorage.com/mtk-seamap/osm.pmtiles',
        output: 'osm.pmtiles',
        minzoom: 0,
        maxzoom: 14,
        format: 'pbf',
        contentType: 'application/x-protobuf',
        attribution: '© OpenStreetMap contributors'
      },
      {
        name: 'mapterhorn',
        url: 'https://download.mapterhorn.com/planet.pmtiles',
        output: 'mapterhorn.pmtiles',
        minzoom: 0,
        maxzoom: 10,
        format: 'webp',
        contentType: 'image/webp',
        encoding: 'terrarium',
        attribution: '<a href="https://mapterhorn.com/attribution" target="_blank">© Mapterhorn</a>'
      },
      {
        name: 'gebco',
        url: 'https://fsn1.your-objectstorage.com/mtk-seamap/gebco.pmtiles',
        output: 'gebco.pmtiles',
        minzoom: 0,
        maxzoom: 9,
        format: 'webp',
        contentType: 'image/webp',
        encoding: 'terrarium',
        attribution: '<a href="https://www.gebco.net" target="_blank">© GEBCO</a>'
      },
      {
        name: 'emod',
        url: 'https://fsn1.your-objectstorage.com/mtk-seamap/emod.pmtiles',
        output: 'emod.pmtiles',
        minzoom: 0,
        maxzoom: 11,
        format: 'webp',
        contentType: 'image/webp',
        encoding: 'terrarium',
        attribution: '<a href="https://emodnet.ec.europa.eu" target="_blank">© EMODnet</a>'
      }
    ];
  }

  emtpyState() {
    return {
      active: false,
      queue: [],
      done: [],
      failed: [],
      progress: null,
      process: null,
      current: 0
    };
  }

  // Check if pmtiles CLI is installed
  checkPmtiles(callback) {
    exec('which pmtiles', (err, stdout) => {
      if (err || !stdout.trim()) {
        callback(false, null);
      } else {
        callback(true, stdout.trim());
      }
    });
  }

  // GET /pmtiles - List all downloaded tile directories
  list(req, res) {
    this.checkPmtiles((installed, pmtilesPath) => {
      if (!installed) {
        return res.status(503).json({
          error: 'pmtiles not installed',
          message: 'The pmtiles CLI tool is not installed on this system'
        });
      }

      const tilesPath = this.seamap.options.pmtilesPath;
      if (!tilesPath) res.status(500).send("No pmtilesPath configured");

      fs.access(tilesPath, fs.constants.R_OK, (err) => {
        if (err) {
          return res.json({
            pmtilesPath,
            basePath: tilesPath,
            tiles: []
          });
        }

        fs.readdir(tilesPath, { withFileTypes: true }, (err, entries) => {
          if (err) {
            return res.status(500).json({ error: 'Failed to read tiles directory' });
          }

          const tiles = [];
          let pending = entries.length;

          if (pending === 0) {
            return res.json({
              pmtilesPath,
              basePath: tilesPath,
              tiles: []
            });
          }

          entries.forEach((entry) => {
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
              const dirPath = path.join(tilesPath, entry.name);
              fs.stat(dirPath, (err, stats) => {
                if (!err) {
                  tiles.push({
                    name: entry.name,
                    created: stats.birthtime,
                    modified: stats.mtime
                  });
                }
                pending--;
                if (pending === 0) {
                  res.json({
                    pmtilesPath,
                    basePath: tilesPath,
                    tiles: tiles.sort((a, b) => a.name.localeCompare(b.name))
                  });
                }
              });
            } else {
              pending--;
              if (pending === 0) {
                res.json({
                  pmtilesPath,
                  basePath: tilesPath,
                  tiles: tiles.sort((a, b) => a.name.localeCompare(b.name))
                });
              }
            }
          });
        });
      });
    });
  }

  // GET /pmtiles/status - Simple polling endpoint for download status
  status(req, res) {
    const state = this.state;
    res.json({
      active: state.active,
      total: (state.queue.length + state.done.length + state.failed.length) * Pmtiles.SOURCES().length,
      done: Math.max(0, (state.done.length + state.failed.length) * Pmtiles.SOURCES().length + state.current - 1),
      progress: state.progress,
    });
  }

  // POST /pmtiles/cancel - Cancel all downloads
  cancel(req, res) {
    if (this.state.process) {
      try {
        this.state.process.kill('SIGTERM');
      } catch (e) {
        // Process already ended
      }
    }
    this.state = this.emtpyState();
    res.json({ status: 'cancelled' });
  }

  // Parse pmtiles progress output
  parseProgress(line) {
    const match = line.match(/([\d\.]+\s*(kB|MB)?\s*\/\s*([\d\.]+)\s*(kB|MB))/);
    return match ? match[1] : null;
  }

  // POST /pmtiles - Start download for tiles (accepts single tile or array)
  download(req, res) {
    let tiles = req.query.tile;

    // Support both single tile and comma-separated list
    if (typeof tiles === 'string') {
      tiles = tiles.split(',').map(t => t.trim()).filter(t => t);
    }

    if (!tiles || tiles.length === 0) {
      return res.status(400).json({
        error: 'Invalid tile parameter',
        message: 'Tile must be in format z/x/y (e.g., 6/34/22)'
      });
    }

    // Validate all tiles
    for (const tile of tiles) {
      if (!/^\d+\/\d+\/\d+$/.test(tile)) {
        return res.status(400).json({
          error: 'Invalid tile parameter',
          message: `Invalid tile format: ${tile}. Must be z/x/y (e.g., 6/34/22)`
        });
      }
    }

    this.checkPmtiles((installed, pmtilesPath) => {
      if (!installed) {
        return res.status(503).json({
          error: 'pmtiles not installed',
          message: 'The pmtiles CLI tool is not installed on this system'
        });
      }

      for (const tile of tiles) {
        if (!this.state.queue.includes(tile)) {
          this.state.queue.push(tile);
        }
      }

      // Start downloading first tile
      if (!this.state.active) {
        this.state.active = true;
        this.processNextTile(pmtilesPath);
      }

      res.json({
        status: 'ok',
        tiles: tiles,
        total: tiles.length
      });
    });
  }

  // Process the current tile or move to next
  processNextTile(pmtilesPath) {
    const state = this.state;

    if (!state.active || state.queue.length === 0) {
      this.state = this.emtpyState();
      return;
    }

    const tile = state.queue[0];
    const tilesPath = this.seamap.options.pmtilesPath;
    const [z, x, y] = tile.split('/');
    const tileDirName = `${z}_${x}_${y}`;
    const tmpDir = path.join(tilesPath, "." + tileDirName);
    const finalDir = path.join(tilesPath, tileDirName);
    const bbox = this.tileToBbox(parseInt(x), parseInt(y), parseInt(z));
    const sources = Pmtiles.SOURCES();
    state.current = 0;

    fs.mkdir(tmpDir, { recursive: true }, (err) => {
      if (err) {
        state.failed.push(state.queue.shift());
        this.processNextTile(pmtilesPath);
        return;
      }

      let failed = false;

      const downloadNextSource = () => {
        if (!state.active) {
          fs.rm(tmpDir, { recursive: true, force: true }, () => {});
          return;
        }
        if (sources.length === 0) {
          if (failed) {
            fs.rm(tmpDir, { recursive: true, force: true }, () => {});
            state.failed.push(state.queue.shift());
          } else {
            fs.rm(finalDir, { recursive: true, force: true }, () => {
              fs.rename(tmpDir, finalDir, err => {
                if (err) state.failed.push(state.queue.shift());
                else state.done.push(state.queue.shift());
                this.processNextTile(pmtilesPath);
              });
            });
          }
          return;
        }

        state.current++;
        const source = sources.shift();
        const outputPath = path.join(tmpDir, source.output);
        const args = [
          'extract',
          source.url,
          outputPath,
          `--bbox=${bbox.west},${bbox.south},${bbox.east},${bbox.north}`
        ];
        if (source.maxzoom) args.push(`--maxzoom=${source.maxzoom}`);

        const proc = spawn(pmtilesPath, args);
        state.process = proc;

        proc.stderr.on('data', (data) => {
          state.progress = [tile, source.name, this.parseProgress(data.toString())]
        });

        proc.on('close', (code) => {
          state.process = null;
          if (code !== 0) failed = true;
          downloadNextSource();
        });

        proc.on('error', () => {
          state.process = null;
          failed = true;
          downloadNextSource();
        });
      };

      downloadNextSource();
    });
  }

  // DELETE /pmtiles?tile=6/34/22 - Delete a tile directory
  delete(req, res) {
    const tile = req.query.tile;

    if (!tile || !/^\d+\/\d+\/\d+$/.test(tile)) {
      return res.status(400).json({
        error: 'Invalid tile parameter',
        message: 'Tile must be in format z/x/y (e.g., 6/34/22)'
      });
    }

    const tilesPath = this.seamap.options.pmtilesPath;
    const [z, x, y] = tile.split('/');
    const tileDir = path.join(tilesPath, `${z}_${x}_${y}`);

    // Security: ensure path is within tiles directory
    const resolvedPath = path.resolve(tileDir);
    if (!resolvedPath.startsWith(path.resolve(tilesPath))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    fs.rm(tileDir, { recursive: true, force: true }, (err) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to delete tile directory' });
      }

      res.json({
        status: 'deleted',
        tile,
        directory: tileDir
      });
    });
  }

  // Convert tile coordinates to bounding box
  tileToBbox(x, y, z) {
    const n = Math.pow(2, z);
    const west = (x / n) * 360 - 180;
    const east = ((x + 1) / n) * 360 - 180;
    const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
    const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
    return { west, east, north, south };
  }

  middleware(router) {
    router.get('/pmtiles', this.list.bind(this));
    router.get('/pmtiles/status', this.status.bind(this));
    router.post('/pmtiles', this.download.bind(this));
    router.post('/pmtiles/cancel', this.cancel.bind(this));
    router.delete('/pmtiles', this.delete.bind(this));
    return router;
  }
}

module.exports = Pmtiles;

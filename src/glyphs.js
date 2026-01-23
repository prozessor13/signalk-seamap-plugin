const path = require('path');
const fs = require('fs');

const GLYPHS_DIR = path.join(__dirname, '..', 'glyphs');

class Glyphs {
  constructor(seamap) {
    this.seamap = seamap;
  }

  getGlyph(req, res) {
    const { fontstack, range } = req.params;

    // Validate range format (e.g., "0-255", "256-511")
    if (!/^\d+-\d+$/.test(range)) {
      return res.status(400).send('Invalid range format');
    }

    const glyphPath = path.join(GLYPHS_DIR, fontstack, `${range}.pbf`);

    // Security: ensure path is within glyphs directory
    const resolvedPath = path.resolve(glyphPath);
    if (!resolvedPath.startsWith(path.resolve(GLYPHS_DIR))) {
      return res.status(403).send('Forbidden');
    }

    fs.access(glyphPath, fs.constants.R_OK, (err) => {
      if (err) {
        return res.status(404).send('Glyph not found');
      }

      res.set('Content-Type', 'application/x-protobuf');
      res.set('Cache-Control', 'public, max-age=86400');

      const stream = fs.createReadStream(glyphPath);
      stream.on('error', () => {
        res.status(500).send('Error reading glyph file');
      });
      stream.pipe(res);
    });
  }

  middleware(router) {
    router.get('/glyphs/:fontstack/:range.pbf', this.getGlyph.bind(this));
    return router;
  }
}

module.exports = Glyphs;

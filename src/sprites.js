const path = require('path');
const fs = require('fs');

const SPRITES_DIR = path.join(__dirname, '..', 'sprites');

class Sprites {
  constructor(seamap) {
    this.seamap = seamap;
  }

  serveFile(res, filePath, contentType) {
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(SPRITES_DIR))) {
      return res.status(403).send('Forbidden');
    }

    fs.access(filePath, fs.constants.R_OK, (err) => {
      if (err) {
        return res.status(404).send('Sprite not found');
      }

      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=86400');

      const stream = fs.createReadStream(filePath);
      stream.on('error', () => {
        res.status(500).send('Error reading sprite file');
      });
      stream.pipe(res);
    });
  }

  getSpriteJson(req, res) {
    const { name } = req.params;
    const filePath = path.join(SPRITES_DIR, `${name}.json`);
    this.serveFile(res, filePath, 'application/json');
  }

  getSpritePng(req, res) {
    const { name } = req.params;
    const filePath = path.join(SPRITES_DIR, `${name}.png`);
    this.serveFile(res, filePath, 'image/png');
  }

  getSpriteJson2x(req, res) {
    const { name } = req.params;
    const filePath = path.join(SPRITES_DIR, `${name}@2x.json`);
    this.serveFile(res, filePath, 'application/json');
  }

  getSpritePng2x(req, res) {
    const { name } = req.params;
    const filePath = path.join(SPRITES_DIR, `${name}@2x.png`);
    this.serveFile(res, filePath, 'image/png');
  }

  middleware(router) {
    router.get('/sprites/:name@2x.json', this.getSpriteJson2x.bind(this));
    router.get('/sprites/:name@2x.png', this.getSpritePng2x.bind(this));
    router.get('/sprites/:name.json', this.getSpriteJson.bind(this));
    router.get('/sprites/:name.png', this.getSpritePng.bind(this));
    return router;
  }
}

module.exports = Sprites;

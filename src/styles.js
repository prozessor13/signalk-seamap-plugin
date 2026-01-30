const path = require('path');
const fs = require('fs');

const STYLES_DIR = path.join(__dirname, '..', 'styles');

class Styles {
  constructor(seamap) {
    this.seamap = seamap;
  }

  getStyle(req, res) {
    const { name } = req.params;
    const filePath = path.join(STYLES_DIR, `${name}.json`);

    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(STYLES_DIR))) {
      return res.status(403).send('Forbidden');
    }

    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        return res.status(404).send('Style not found');
      }

      res.set('Content-Type', 'application/json');
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(data);
    });
  }

  middleware(router) {
    router.get('/styles/:name.json', this.getStyle.bind(this));
    return router;
  }
}

module.exports = Styles;

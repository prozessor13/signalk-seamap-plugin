const Glyphs = require('./src/glyphs');
const Sprites = require('./src/sprites');
const Styles = require('./src/styles');
const Pmtiles = require('./src/pmtiles');
const Tiles = require('./src/tiles');
const Contours = require('./src/contours');
const Soundings = require('./src/soundings');

module.exports = function(app) {
  const seamap = { app, options: {} };
  const styles = new Styles(seamap);
  const sprites = new Sprites(seamap);
  const glyphs = new Glyphs(seamap);
  const pmtiles = new Pmtiles(seamap);
  const tiles = new Tiles(seamap, pmtiles);
  const contours = new Contours(seamap, tiles);
  const soundings = new Soundings(seamap, contours);

  return {
    id: 'signalk-seamap-plugin',
    name: 'Global Seacharts based on OSM/Gebco/Emod',
    schema: () => ({
      title: 'Seamap Charts',
      type: 'object',
      properties: {
        pmtilesPath: {
          type: 'string',
          title: 'Path to store offline pmtiles',
          default: `${app.config.configPath}/seamap/pmtiles`
        },
        stylesPath: {
          type: 'string',
          title: 'Path for MapLibreGL stylesheets.',
          default: `${app.config.configPath}/seamap/styles`
        },
        tilesPath: {
          type: 'string',
          title: 'Path to cache downloaded and generated tiles.',
          default: `${app.config.configPath}/seamap/tiles`
        },
        bathymetryDepthLevels: {
          type: 'string',
          title: 'Bathymety contour lines',
          description: 'comma separated string with all depth levels for bathymetry contourlines',
          default: '0,2,5,10,20,50'
        },
      }
    }),
    start: function(options) {
      this.started = true;
      seamap.options = options;
      tiles.initializeTileCache();
    },
    stop: function() {
      this.started = false;
    },
    registerWithRouter: function(router) {
      styles.middleware(router);
      sprites.middleware(router);
      glyphs.middleware(router);
      pmtiles.middleware(router);
      tiles.middleware(router);
      contours.middleware(router);
      soundings.middleware(router);
    },
    getOpenApi: () => require('./openApi'),
    app: app
  }
}
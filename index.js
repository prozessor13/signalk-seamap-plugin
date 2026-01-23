const Glyphs = require('./src/glyphs');
const Sprites = require('./src/sprites');
const Styles = require('./src/styles');
const Pmtiles = require('./src/pmtiles');
// const Tiles = require('./src/tiles');

module.exports = function(app) {
  const seamap = { app };
  const styles = new Styles(seamap);
  const sprites = new Sprites(seamap);
  const glyphs = new Glyphs(seamap);
  const pmtiles = new Pmtiles(seamap);
  // const tiles = new Pmtiles(seamap, pmtiles);

  return {
    id: 'signalk-seamap-plugin',
    name: 'Global Seacharts based on OSM/Gebco/Emod',
    schema: () => ({
      title: 'Seamap Charts',
      type: 'object',
      properties: {
        path: {
          type: 'string',
          title: 'Path to store offline pmtiles',
          description: `Enter path relative to ${app.config.configPath}. Defaults to /seamap/pmtiles`,
          default: `${app.config.configPath}/seamap/pmtiles`
        },
        stylesPath: {
          type: 'string',
          title: 'Path for MapLibreGL stylesheets.',
          description: `Enter path relative to ${app.config.configPath}. Defaults to /seamap/styles`,
          default: `${app.config.configPath}/seamap/styles`
        },
        tilesPath: {
          type: 'string',
          title: 'Path to cache ondemand generated tiles.',
          description: `Enter path relative to ${app.config.configPath}. Defaults to /seamap/tiles`,
          default: `${app.config.configPath}/seamap/tiles`
        },
        contourDepthLevels: {
          type: 'string',
          title: 'Bathymety contourlines',
          title: 'comma separated string with all depth levels for bathymetry contourlines',
          default: '2,5,10,20,50,100,250,500,1000,2000,3000,4000,5000'
        },
        bathymetryDepthLevels: {
          type: 'string',
          title: 'Bathymety depth polygons',
          description: 'comma separated string with all depth levels for bathymetry areas',
          default: '2,5,10,20,50'
        },
      }
    }),
    start: function(options) {
      this.started = true;
      seamap.options = options;
    },
    stop: function() {
      this.started = false;
    },
    registerWithRouter: function(router) {
      styles.middleware(router);
      sprites.middleware(router);
      glyphs.middleware(router);
      pmtiles.middleware(router);
      // tiles.middleware(router);
    },
    getOpenApi: () => require('./openApi'),
    app: app
  }
}
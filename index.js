const Glyphs = require('./src/glyphs');
const Sprites = require('./src/sprites');
const Styles = require('./src/styles');
const Pmtiles = require('./src/pmtiles');
const Tiles = require('./src/tiles');
const Contours = require('./src/contours');
const Bathymetry = require('./src/bathymetry');
const Soundings = require('./src/soundings');
const Composite = require('./src/composite');
const Charts = require('./src/charts');

module.exports = function(app) {
  const seamap = { app, options: {} };
  const styles = new Styles(seamap);
  const sprites = new Sprites(seamap);
  const glyphs = new Glyphs(seamap);
  const pmtiles = new Pmtiles(seamap);
  const tiles = new Tiles(seamap, pmtiles);
  const contours = new Contours(seamap, tiles);
  const bathymetry = new Bathymetry(seamap, tiles);
  const soundings = new Soundings(seamap, contours);
  const composite = new Composite(seamap, tiles, contours, bathymetry, soundings);
  const charts = new Charts(seamap);

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
        soundingsShallowSpacing: {
          type: 'number',
          title: 'Spot sounding spacing — shallow water (px)',
          description: 'Approximate screen distance in pixels between spot soundings in shallow water (2 m and less). Soundings are selected server-side (shoalest first, fixed positions), so zooming only adds or removes soundings. Between 2 m and 30 m the spacing blends towards the deep water value.',
          default: 32
        },
        soundingsDeepSpacing: {
          type: 'number',
          title: 'Spot sounding spacing — deep water (px)',
          description: 'Approximate screen distance in pixels between spot soundings in deep water (30 m and more).',
          default: 64
        },
      }
    }),
    start: function(options) {
      this.started = true;
      seamap.options = options;
      tiles.initializeTileCache();
      charts.register();
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
      bathymetry.middleware(router);
      soundings.middleware(router);
      composite.middleware(router);
    },
    getOpenApi: () => require('./openApi'),
    app: app
  }
}
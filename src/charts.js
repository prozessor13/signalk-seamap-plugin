const PLUGIN_ID = 'signalk-seamap-plugin';
const PLUGIN_PATH = `/plugins/${PLUGIN_ID}`;

// Charts exposed through the Signal K resources/charts API so that SK apps
// (e.g. Freeboard) discover this plugin's seacharts automatically.
//
// They are served as MapLibre GL style definitions (type 'mapstyleJSON').
// Freeboard renders these with OpenLayers + ol-mapbox-style (NOT MapLibre), so
// we expose the *-ol style variants (see scripts/build-ol-styles.js), which are
// tuned for ol-mapbox-style's renderer. The style's {BASE_URL} placeholder
// resolves to '' here, so the embedded tile/sprite/glyph URLs become
// root-relative and resolve against the Signal K server origin. The {BATHYMETRY}
// placeholder is selected via the ?bathymetry= query parameter (gebco | emod).
//
// Each style is offered twice — once per bathymetry source (GEBCO, EMODnet).
function chart(id, label, style, bathymetry) {
  return {
    identifier: id,
    name: label,
    description: `Global vector seachart (OSM/OpenSeaMap) with ${bathymetry === 'emod' ? 'EMODnet' : 'GEBCO'} bathymetry`,
    type: 'mapstyleJSON',
    format: 'pbf',
    url: `${PLUGIN_PATH}/styles/${style}.json?bathymetry=${bathymetry}`,
    scale: 250000,
    minzoom: 0,
    maxzoom: 24,
    bounds: [-180, -85, 180, 85]
  };
}

const CHARTS = {
  'seamap-gebco': chart('seamap-gebco', 'Seamap (GEBCO)', 'seamap-ol-slim', 'gebco'),
  'seamap-emod': chart('seamap-emod', 'Seamap (EMODnet)', 'seamap-ol-slim', 'emod')
};

class Charts {
  constructor(seamap) {
    this.seamap = seamap;
  }

  // Register this plugin as a read-only resource provider for 'charts'.
  register() {
    const app = this.seamap.app;

    if (typeof app.registerResourceProvider !== 'function') {
      app.debug && app.debug('registerResourceProvider not available - skipping charts resource provider');
      return;
    }

    try {
      app.registerResourceProvider({
        type: 'charts',
        methods: {
          listResources: () => Promise.resolve({ ...CHARTS }),
          getResource: (id) => {
            const chart = CHARTS[id];
            if (chart) {
              return Promise.resolve(chart);
            }
            throw new Error(`Chart not found: ${id}`);
          },
          setResource: () => {
            throw new Error('Not supported: seamap charts are read-only');
          },
          deleteResource: () => {
            throw new Error('Not supported: seamap charts are read-only');
          }
        }
      });
      app.debug && app.debug(`Registered charts resource provider: ${Object.keys(CHARTS).join(', ')}`);
    } catch (err) {
      const msg = `Failed to register charts resource provider: ${err.message}`;
      app.error ? app.error(msg) : console.error(msg);
    }
  }
}

module.exports = Charts;

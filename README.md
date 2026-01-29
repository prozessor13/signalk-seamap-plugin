# SignalK Seamap Plugin

Global sea charts based on OSM/Gebco/Emod for SignalK with online and offline capabilities.

## Overview

This plugin provides offline-first map tile serving for SignalK with intelligent fallback strategies. It supports both vector tiles (MVT/PBF) and raster tiles (PNG/JPEG/WebP) from multiple sources. This project is in alpha stage but should be functional.

## Features

- **Offline PMTiles Support**: Download and serve map tiles from sector-based PMTiles archives
- **Online Fallback**: Automatically fetch tiles from remote sources when internet is available
- **Smart Caching**: Filesystem-based tile cache with 7-day retention
- **Multiple Sources**: Support for OSM, Seamap, Gebco, Emod, and Mapterhorn
- **Tile Formats**: Vector (MVT/PBF) and Raster (PNG, JPEG, WebP)
- **Sprites & Glyphs**: MapLibre GL compatible sprite sheets and font glyphs
- **Custom Styles**: MapLibre GL style definitions
- **On-Demand Contour Lines**: Dynamically generates contour and bathymetry lines with filesystem caching

## Architecture

### File Structure

```
signalk-seamap-plugin/
├── index.js                # Plugin entry point and configuration
├── package.json            # NPM package configuration
├── openApi.json            # OpenAPI specification
├── src/
│   ├── tiles.js            # Tile serving with multi-strategy fallback
│   ├── pmtiles.js          # PMTiles download and sector management
│   ├── contours.js         # Contour line generation and processing
│   ├── soundings.js        # Depth sounding data handling
│   ├── styles.js           # MapLibre GL style serving
│   ├── sprites.js          # Sprite sheet serving
│   ├── glyphs.js           # Font glyph serving
│   └── maplibre-contour/   # MapLibre contour library
├── sprites/                # Sprite images and metadata
├── glyphs/                 # Font PBF files
├── styles/                 # Map style definitions
└── public/                 # Web interface for tile management
```

## Installation

### Prerequisites

The PMTiles CLI tool is required for downloading offline map sectors:

**macOS:**
```bash
brew install pmtiles
```

**Linux:**
```bash
# Download latest release from GitHub
wget https://github.com/protomaps/go-pmtiles/releases/latest/download/go-pmtiles_$(uname -s)_$(uname -m).tar.gz
tar -xzf go-pmtiles_*.tar.gz
sudo mv pmtiles /usr/local/bin/
```

**Docker/Raspberry Pi:**
```bash
# ARM64
wget https://github.com/protomaps/go-pmtiles/releases/latest/download/go-pmtiles_Linux_arm64.tar.gz
tar -xzf go-pmtiles_Linux_arm64.tar.gz
sudo mv pmtiles /usr/local/bin/
```

Verify installation:
```bash
pmtiles --version
```

### Plugin Installation

Install via SignalK App Store or manually:
```bash
cd ~/.signalk/node_modules
git clone https://github.com/yourusername/signalk-seamap-plugin.git
cd signalk-seamap-plugin
npm install
```

## Configuration

The plugin can be configured through SignalK's plugin configuration interface:

```javascript
{
  pmtilesPath: '/path/to/pmtiles',           // Offline PMTiles storage (default: ~/.signalk/seamap/pmtiles)
  stylesPath: '/path/to/styles',             // MapLibre GL stylesheets (default: ~/.signalk/seamap/styles)
  tilesPath: '/path/to/tiles-cache',         // Tile cache directory (default: ~/.signalk/seamap/tiles)
  bathymetryDepthLevels: '2,5,10,20,50'      // Comma-separated depth levels for bathymetry contours (default: '2,5,10,20,50')
}
```

---

## Tile Serving

### Multi-Strategy Tile Retrieval

The plugin implements a multi-tier fallback strategy to ensure tiles are always available when possible:

```
1. Check File Cache & Offline PMTiles
   - Cached tile (if exists and < 7 days old)
   - Offline PMTiles sector (if newer than cache)
   ↓ (if not found or older than 7 days)

2. Online Fetch (if internet available)
   - Fetch from online PMTiles archive via HTTP Range requests
   - Save to file cache for future use
   ↓ (if not available or fails)

3. Return 204 No Content
```

### Strategy Details

#### 1. File Cache Check
- **Location**: `{tilesPath}/tiles/{source}/{z}/{x}/{y}`
- **Example**: `~/.signalk/seamap/tiles/tiles/osm/8/132/88`
- **Used when**: Cached file exists and is fresher than 7 days old
- Contains tiles previously fetched from online or offline PMTiles
- Includes modification timestamp for age comparison

**How it works:**
1. Check if cached tile file exists
2. Compare file modification time with current time
3. If file exists and is less than 7 days old, serve from cache
4. Cache is organized by source and tile coordinates

#### 2. Offline PMTiles Sectors
- **Location**: `{pmtilesPath}/{z6}_{x6}_{y6}/{source}.pmtiles`
- **Example**: `~/.signalk/seamap/pmtiles/6_33_22/osm.pmtiles`
- Tile coordinates are automatically reduced from requested zoom to zoom level 6 to locate the correct PMTiles archive
- **Used when**: PMTiles file exists and is newer than cached file

**How it works:**
When you request tile `8/132/88`, the system:
1. Calculates parent tile at zoom 6: `6/33/22`
2. Looks for `{pmtilesPath}/6_33_22/osm.pmtiles`
3. Compares PMTiles file timestamp with cached tile timestamp
4. Serves the newest version from either cache

#### 3. Online Fetch
- **Only attempted when**: Cache and offline PMTiles are older than 7 days OR not found
- **Connectivity check**: System checks internet availability every 10 seconds
- Fetches directly from source PMTiles URL using HTTP Range requests
- Downloads only the requested tile, not the entire archive
- Automatically saves to file cache with current timestamp


### Tile Cache Directory

Tiles are cached in the filesystem using the directory specified in plugin options. The filesystem-based approach was chosen because SQLite databases continuously grow with every insert/update operation. Running VACUUM operations to reclaim space is computationally expensive on embedded systems.

### API Endpoints

Overview of API endpoints for MapLibre sources:

> **Complete API documentation available in [openApi.json](openApi.json)**

#### Styles & Assets
- `GET /styles/{name}.json` - MapLibre GL styles
- `GET /sprites/{name}.json|.png|@2x.json|@2x.png` - Sprite sheets
- `GET /glyphs/{fontstack}/{range}.pbf` - Font glyphs

**Available Sources**: `seamap`, `osm`, `mapterhorn`, `gebco`, `emod`

#### Tiles
- `GET /tiles/{name}.json` - TileJSON metadata
- `GET /tiles/{name}/{z}/{x}/{y}.{format}` - Map tiles (pbf, webp)

#### Contours & Bathymetry Tiles
- `GET /contours/{name}.json` - Contour lines TileJSON
- `GET /contours/{name}/{z}/{x}/{y}.pbf` - Contour tiles
- `GET /bathymetry/{name}.json` - Bathymetry TileJSON
- `GET /bathymetry/{name}/{z}/{x}/{y}.pbf` - Bathymetry tiles
- `GET /soundings/{name}.json` - Soundings TileJSON
- `GET /soundings/{name}/{z}/{x}/{y}.pbf` - Soundings tiles

---

## PMTiles Management

### Sector-Based Download System

Instead of downloading entire global PMTiles archives (hundreds of GB), the plugin downloads only specific geographic sectors at zoom level 6.

**Why Zoom Level 6?**
- Balances coverage area and file size
- Each ZL6 tile covers approximately 350km × 350km at the equator
- Typical sector download size: 50-1000 MB
- Enables efficient offline operation for specific regions

### Available Sources

| Source | Type | Description | Max Zoom |
|--------|------|-------------|----------|
| **mapterhorn** | Vector | Global basemap | 10 |
| **osm** | Vector | OpenStreetMap features | 14 |
| **seamap** | Vector | Nautical chart data | 14 |
| **gebco** | Raster | Bathymetry (ocean depth) | 14 |
| **emod** | Raster | European bathymetry | 14 |

### Download Process

The download is done via the pmtiles cmdline utility. This commandline utility is not part of this plugin, and has to be installed separately.

#### Installing PMTiles CLI

**macOS:**
```bash
brew install pmtiles
```

**Linux:**
```bash
# Download latest release from GitHub
wget https://github.com/protomaps/go-pmtiles/releases/latest/download/go-pmtiles_$(uname -s)_$(uname -m).tar.gz
tar -xzf go-pmtiles_*.tar.gz
sudo mv pmtiles /usr/local/bin/
```

**Docker/Raspberry Pi (ARM64):**
```bash
wget https://github.com/protomaps/go-pmtiles/releases/latest/download/go-pmtiles_Linux_arm64.tar.gz
tar -xzf go-pmtiles_Linux_arm64.tar.gz
sudo mv pmtiles /usr/local/bin/
```

**Verify installation:**
```bash
pmtiles --version
```

## Styles

### MapLibre GL Style Serving

Serves complete MapLibre GL style definitions for rendering maps.

**Directory**: `styles/`

**Example:**
```bash
GET /styles/seamap.json
```

**Features:**
- Complete style definitions referencing local tile sources
- Sprite and glyph URL templates
- Layer styling for map rendering
- 24-hour cache headers for performance

---

## Sprites

**Directory**: `sprites/`

Provides sprite sheets for map icons and symbols in MapLibre GL format.

## Glyphs

**Directory**: `glyphs/`

Currently only Noto Sans fonts are included with this plugin.

## Credits

- [Maptoolkit.net](https://maptoolkit.com) - For supporting this project and providing hardware resources
- [PMTiles](https://github.com/protomaps/PMTiles) - Cloud-optimized tile archives
- [MapLibre GL](https://maplibre.org/) - Open-source map rendering
- [OpenStreetMap](https://www.openstreetmap.org/) - Map data
- [GEBCO](https://www.gebco.net/) - Bathymetry data

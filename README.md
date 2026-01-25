# SignalK Seamap Plugin

Global Seacharts based on OSM/Gebco/Emod for SignalK

## Overview

This plugin provides offline-first map tile serving for SignalK with intelligent fallback strategies. It supports both vector tiles (MVT/PBF) and raster tiles (PNG/JPEG/WebP) from multiple sources.

## Features

- **Offline PMTiles Support**: Download and serve map tiles from sector-based PMTiles archives
- **Online Fallback**: Automatically fetch tiles from remote sources when internet is available
- **Smart Caching**: SQLite-based tile cache with timestamp comparison
- **Multiple Sources**: Support for OSM, Seamap, Gebco, Emod, and Mapterhorn
- **Tile Formats**: Vector (MVT) and Raster (PNG, JPEG, WebP)
- **Sprites & Glyphs**: MapLibre GL compatible sprite sheets and font glyphs
- **Custom Styles**: Support for MapLibre GL style definitions

## Architecture

### File Structure

```
signalk-seamap-plugin/
├── index.js                 # Plugin entry point and configuration
├── src/
│   ├── tiles.js            # Tile serving with multi-strategy fallback
│   ├── pmtiles.js          # PMTiles download and sector management
│   ├── styles.js           # MapLibre GL style serving
│   ├── sprites.js          # Sprite sheet serving
│   └── glyphs.js           # Font glyph serving
├── sprites/                # Sprite images and metadata
├── fonts/                  # Font PBF files
└── public/                 # Web interface for tile management
```

## Configuration

The plugin can be configured through SignalK's plugin configuration interface:

```javascript
{
  path: '/path/to/pmtiles',           // Offline PMTiles storage
  stylesPath: '/path/to/styles',      // MapLibre GL stylesheets
  tilesPath: '/path/to/tiles-cache',  // SQLite tile cache
  contourDepthLevels: '2,5,10,20,50,100,250,500,1000,2000,3000,4000,5000',
  bathymetryDepthLevels: '2,5,10,20,50'
}
```

---

## Tile Serving

### Multi-Strategy Tile Retrieval

The plugin implements a three-tier fallback strategy to ensure tiles are always available when possible:

```
1. Offline PMTiles (if newer than cache)
   ↓ (if not found or older)
2. Online Fetch (if internet available)
   ↓ (if not available)
3. SQLite Cache (last resort)
   ↓ (if not found)
4. Return 204 No Content
```

### Strategy Details

#### 1. Offline PMTiles
- **Location**: `{path}/{z6}_{x6}_{y6}/{source}.pmtiles`
- **Example**: `pmtiles/6_33_22/osm.pmtiles`
- Tile coordinates are automatically reduced from requested zoom to zoom level 6
- File modification time is compared with cache timestamp
- **Used when**: File exists AND (no cache OR file is newer than cache)
- **Response header**: `X-Tile-Source: offline`

**How it works:**
When you request tile `8/132/88`, the system:
1. Calculates parent tile at zoom 6: `6/33/22`
2. Looks for `{path}/6_33_22/osm.pmtiles`
3. Extracts the requested tile `8/132/88` from this archive
4. Checks if this file is newer than cached version

#### 2. Online Fetch
- **Only attempted when**: Internet connectivity detected (checked every 10 seconds)
- Fetches directly from source PMTiles URL using HTTP Range requests
- Downloads only the requested tile, not the entire archive
- Automatically saves to SQLite cache with current timestamp
- **Response header**: `X-Tile-Source: online`

**How it works:**
1. Uses HTTP Range requests to read only necessary bytes from remote PMTiles
2. PMTiles format allows random access without downloading full file
3. Tile is cached locally for future offline use
4. Cache entry includes timestamp for freshness comparison

#### 3. SQLite Cache
- **Used when**: Offline AND no internet OR cache is newer than offline file
- Contains tiles previously fetched online
- Includes timestamp for freshness comparison
- **Response header**: `X-Tile-Source: cache`

**Use cases:**
- You previously had internet and fetched tiles online
- Now offline, but cached tiles are still available
- Cache tiles are newer than downloaded PMTiles (updated online data)

### Connectivity Monitoring

**How it works:**
- Automatic check every 10 seconds
- Sends HEAD request to first source URL
- Sets online/offline state based on response (HTTP 200-399 = online)
- 5-second timeout per check
- No impact on tile serving if check fails

### Tile Cache Database

**Storage**: `{tilesPath}/tiles.db` (SQLite)

**Data stored per tile:**
- Source name (osm, seamap, gebco, emod, mapterhorn)
- Tile coordinates (z, x, y)
- Binary tile data (compressed)
- Content type (image/png, application/x-protobuf, etc.)
- Timestamp (milliseconds since epoch)

**Benefits:**
- Fast lookups by tile coordinates
- Automatic deduplication (PRIMARY KEY constraint)
- Efficient storage (only requested tiles cached)
- Age tracking for potential cleanup

### Content Types by Format

| Tile Format | Content-Type | Encoding | Source Example |
|-------------|--------------|----------|----------------|
| MVT (Vector) | `application/x-protobuf` | `gzip` | OSM, Seamap, Mapterhorn |
| PNG (Raster) | `image/png` | - | Gebco, Emod |
| JPEG (Raster) | `image/jpeg` | - | Satellite imagery |
| WebP (Raster) | `image/webp` | - | Modern raster tiles |

### TileJSON Generation

**Endpoint:** `GET /tiles/{source}.json`

Provides metadata about a tile source in TileJSON 3.0 format.

**What it contains:**
- **Global bounds**: `[-180, -85, 180, 85]` (all sources cover entire world)
- **Center point**: `[0, 0, avgZoom]`
- **Zoom range**: Min and max zoom levels for the source
- **Tile URL template**: With correct format extension (.pbf, .png, etc.)
- **Vector layers**: Layer definitions for vector tiles
- **Attribution**: Copyright and data source information

**Example Response:**
```json
{
  "tilejson": "3.0.0",
  "name": "osm",
  "description": "OpenStreetMap tiles",
  "version": "1.0.0",
  "attribution": "© OpenStreetMap contributors",
  "scheme": "xyz",
  "tiles": ["http://localhost:3000/tiles/osm/{z}/{x}/{y}.pbf"],
  "minzoom": 0,
  "maxzoom": 14,
  "bounds": [-180, -85, 180, 85],
  "center": [0, 0, 7],
  "format": "pbf",
  "vector_layers": [...]
}
```

**Metadata caching:**
- Loaded once at plugin startup
- Read from first available PMTiles file per source
- No filesystem access on subsequent TileJSON requests
- Falls back to defaults if no offline files exist

### API Endpoints

**Get Tile:**
```
GET /tiles/{source}/{z}/{x}/{y}.{format}
```
- **source**: osm, seamap, gebco, emod, mapterhorn
- **z, x, y**: Tile coordinates (XYZ schema)
- **format**: pbf, mvt (vector) or png, jpg, webp (raster)

**Examples:**
```bash
# Vector tile from OpenStreetMap
GET /tiles/osm/8/132/88.pbf

# Raster tile from Gebco bathymetry
GET /tiles/gebco/6/34/22.png
```

**Get TileJSON:**
```
GET /tiles/{source}.json
```

**Example:**
```bash
# Get metadata for OSM source
GET /tiles/osm.json
```

---

## PMTiles Management

### Sector-Based Download System

Instead of downloading entire global PMTiles archives (hundreds of GB), the plugin downloads only specific geographic sectors at zoom level 6.

**Why Zoom Level 6?**
- Balance between coverage area and file size
- Each ZL6 tile covers ~350km x 350km at equator
- Typical sector download: 50-500 MB (vs. 50-200 GB for global)
- Enables offline operation for specific regions

### Tile Coordinate System

**Coordinate Reduction:**
Any tile request at any zoom level is automatically reduced to its parent zoom level 6 tile:

```
Zoom 8:  8/132/88   →  6/33/22
Zoom 10: 10/530/354 →  6/33/22
Zoom 12: 12/2121/1417 → 6/33/22
```

**Formula:**
```javascript
z6 = 6
x6 = floor(x / 2^(z - 6))
y6 = floor(y / 2^(z - 6))
```

**Directory Structure:**
```
pmtiles/
├── 6_33_22/           # European sector
│   ├── osm.pmtiles
│   ├── seamap.pmtiles
│   ├── gebco.pmtiles
│   ├── emod.pmtiles
│   └── mapterhorn.pmtiles
├── 6_34_22/           # Adjacent sector
│   └── ...
└── 6_33_23/           # Another sector
    └── ...
```

### Available Sources

| Source | Type | Description | Max Zoom |
|--------|------|-------------|----------|
| **mapterhorn** | Vector | Global basemap | 10 |
| **osm** | Vector | OpenStreetMap features | 14 |
| **seamap** | Vector | Nautical chart data | 14 |
| **gebco** | Raster | Bathymetry (ocean depth) | 14 |
| **emod** | Raster | European bathymetry | 14 |

### Download Process

**1. Request Download:**
```bash
POST /pmtiles?tile=6/34/22
```

**2. System Actions:**
- Validates tile format (z/x/y)
- Calculates geographic bounding box for tile
- Creates temporary directory: `.6_34_22/`
- Downloads each source sequentially:
  ```bash
  pmtiles extract https://source.com/planet.pmtiles output.pmtiles \
    --bbox=west,south,east,north \
    --maxzoom=14
  ```
- On success: Renames `.6_34_22/` → `6_34_22/`
- On failure: Removes temporary directory

**3. Multiple Sources:**
For each tile, all 5 sources are downloaded before moving to next tile:
- mapterhorn.pmtiles
- osm.pmtiles
- seamap.pmtiles
- gebco.pmtiles
- emod.pmtiles

**4. Multiple Tiles:**
```bash
POST /pmtiles?tile=6/34/22,6/35/22,6/34/23
```
- Adds all tiles to queue
- Processes one at a time
- Downloads all 5 sources for each tile

### Download Management

**Check Status:**
```bash
GET /pmtiles/status
```

Response:
```json
{
  "active": true,
  "total": 15,        // Total sources to download (tiles × 5)
  "done": 7,          // Completed sources
  "progress": ["6/34/22", "osm", "5.2MB / 12.8MB"]
}
```

**Progress Tracking:**
- Real-time progress from pmtiles CLI stderr
- Format: `[tile, source, "downloaded / total"]`
- Example: `["6/34/22", "osm", "5.2MB / 12.8MB"]`

**Cancel Downloads:**
```bash
POST /pmtiles/cancel
```
- Terminates current pmtiles process (SIGTERM)
- Clears download queue
- Removes incomplete temporary directory
- State reset to idle

**List Downloaded Sectors:**
```bash
GET /pmtiles
```

Response:
```json
{
  "pmtilesPath": "/usr/local/bin/pmtiles",
  "basePath": "/data/pmtiles",
  "tiles": [
    {
      "name": "6_34_22",
      "created": "2024-01-15T10:30:00.000Z",
      "modified": "2024-01-15T10:35:00.000Z"
    }
  ]
}
```

**Delete Sector:**
```bash
DELETE /pmtiles?tile=6/34/22
```
- Removes entire sector directory: `{path}/6_34_22/`
- Deletes all 5 source files within
- Path traversal protection enforced

### Geographic Bounding Box Calculation

Converts tile coordinates to geographic bounds for pmtiles extract:

```
Input:  Tile 6/34/22 (ZL6, X=34, Y=22)
Output: {west: 11.25, south: 40.98, east: 16.88, north: 44.09}
```

**Used for:**
- PMTiles extraction (--bbox parameter)
- Ensures correct geographic area is downloaded
- Web Mercator projection calculations

### PMTiles CLI Detection

**Startup Check:**
The plugin verifies `pmtiles` CLI is installed:
```bash
which pmtiles
```

**If not found:**
- All download endpoints return HTTP 503
- Error message indicates missing tool
- Other functionality (serving existing tiles) continues working

**Installation:**
```bash
# macOS
brew install protomaps/pmtiles/pmtiles

# Linux
wget https://github.com/protomaps/go-pmtiles/releases/latest/download/pmtiles_linux_x86_64
chmod +x pmtiles_linux_x86_64
sudo mv pmtiles_linux_x86_64 /usr/local/bin/pmtiles
```

---

## Styles

### MapLibre GL Style Serving

Serves complete MapLibre GL style definitions for rendering maps.

**Directory**: `styles/`

**Endpoint:**
```
GET /styles/{name}.json
```

**Example:**
```bash
GET /styles/seamap-basic.json
```

**Style Format:**
```json
{
  "version": 8,
  "name": "Seamap Basic",
  "sources": {
    "osm": {
      "type": "vector",
      "url": "http://localhost:3000/tiles/osm.json"
    },
    "gebco": {
      "type": "raster",
      "url": "http://localhost:3000/tiles/gebco.json"
    }
  },
  "sprite": "http://localhost:3000/sprites/seamap",
  "glyphs": "http://localhost:3000/fonts/{fontstack}/{range}.pbf",
  "layers": [
    {
      "id": "ocean",
      "type": "fill",
      "source": "osm",
      "source-layer": "water",
      "paint": {
        "fill-color": "#aad3df"
      }
    }
  ]
}
```

**Features:**
- Complete style definitions referencing local tile sources
- Sprite and glyph URL templates
- Layer styling for map rendering
- 24-hour cache headers for performance

---

## Sprites

### Map Symbol Sprite Sheets

Provides sprite sheets for map icons and symbols in MapLibre GL format.

**Directory**: `sprites/`

**Format:**
Each sprite set consists of two files:
1. **JSON metadata**: Icon positions and dimensions
2. **PNG image**: Sprite sheet atlas (all icons in one image)

**Resolutions:**
- **1x (standard)**: For normal displays
- **2x (retina)**: For high-DPI displays

**Endpoints:**
```
GET /sprites/{name}.json       # 1x metadata
GET /sprites/{name}.png        # 1x image
GET /sprites/{name}@2x.json    # 2x metadata
GET /sprites/{name}@2x.png     # 2x image
```

**Example Metadata (JSON):**
```json
{
  "airport": {
    "width": 16,
    "height": 16,
    "x": 0,
    "y": 0,
    "pixelRatio": 1
  },
  "harbor": {
    "width": 20,
    "height": 20,
    "x": 16,
    "y": 0,
    "pixelRatio": 1
  },
  "lighthouse": {
    "width": 18,
    "height": 18,
    "x": 36,
    "y": 0,
    "pixelRatio": 1
  }
}
```

**Usage in Style:**
```json
{
  "sprite": "http://localhost:3000/sprites/seamap",
  "layers": [
    {
      "id": "harbors",
      "type": "symbol",
      "source": "osm",
      "layout": {
        "icon-image": "harbor",
        "icon-size": 1
      }
    }
  ]
}
```

---

## Glyphs

### Font Serving for Map Labels

Provides vector font glyphs in Protocol Buffer (PBF) format for rendering text on maps.

**Directory**: `fonts/`

**Format:**
Fonts are organized by fontstack, with each Unicode range in a separate PBF file.

**Structure:**
```
fonts/
├── Roboto Regular/
│   ├── 0-255.pbf       # Basic Latin
│   ├── 256-511.pbf     # Latin Extended
│   ├── 8192-8303.pbf   # Punctuation
│   └── ...
├── Roboto Bold/
│   └── ...
└── Noto Sans/
    └── ...
```

**Endpoint:**
```
GET /fonts/{fontstack}/{range}.pbf
```

**Parameters:**
- **fontstack**: Font name (URL-encoded), e.g., "Roboto Regular", "Roboto Bold"
- **range**: Unicode range, e.g., "0-255", "256-511"

**Examples:**
```bash
# Basic Latin characters for Roboto Regular
GET /fonts/Roboto%20Regular/0-255.pbf

# Latin Extended for Roboto Bold
GET /fonts/Roboto%20Bold/256-511.pbf
```

**Common Unicode Ranges:**
- `0-255`: Basic Latin, Latin-1 Supplement
- `256-511`: Latin Extended-A, Latin Extended-B
- `8192-8303`: General Punctuation
- `8704-8959`: Mathematical Operators
- `9728-9983`: Dingbats

**Usage in Style:**
```json
{
  "glyphs": "http://localhost:3000/fonts/{fontstack}/{range}.pbf",
  "layers": [
    {
      "id": "city-labels",
      "type": "symbol",
      "source": "osm",
      "layout": {
        "text-field": "{name}",
        "text-font": ["Roboto Regular"],
        "text-size": 12
      }
    }
  ]
}
```

---

## Performance Optimizations

### PMTiles File Handle Caching

**Problem**: Opening too many PMTiles files can exceed OS limits (typically 256-1024 open files)

**Solution**: LRU (Least Recently Used) cache with max 50 open files

**How it works:**
1. When a tile is requested, check if PMTiles file is already open
2. If yes, move to end of cache (mark as recently used)
3. If no, open the file
4. If cache is full (50 files), close the oldest (least recently used)
5. Add newly opened file to cache

**Benefits:**
- Prevents "too many open files" errors
- Fast access to frequently used files
- Automatic cleanup of idle files
- Minimal memory footprint

### Metadata Caching

**At Startup:**
- Read header and metadata from first available PMTiles file per source
- Store in memory: minZoom, maxZoom, tileType, metadata, url
- No further disk access needed for TileJSON requests

**Benefits:**
- TileJSON responses are instant (no I/O)
- Zoom range validation is immediate
- Tile type detection is cached
- Reduced disk operations

### HTTP Caching Headers

Proper cache headers minimize bandwidth and latency:

**Tiles** (24 hours):
```
Cache-Control: public, max-age=86400
```
- Tiles rarely change
- Long cache duration reduces server load
- Client browsers and CDNs can cache

**TileJSON** (1 hour):
```
Cache-Control: public, max-age=3600
```
- Metadata can change with plugin updates
- Shorter duration allows updates to propagate
- Still reduces repeated requests

**Static Assets** (24 hours):
```
Cache-Control: public, max-age=86400
```
- Sprites, glyphs, styles rarely change
- Long cache maximizes performance

### Streaming Responses

All file serving uses Node.js streams instead of loading into memory:

```javascript
fs.createReadStream(filePath).pipe(res);
```

**Benefits:**
- Constant memory usage regardless of file size
- Faster initial response (starts sending immediately)
- Can serve large files without memory issues
- Automatic backpressure handling

---

## Security

### Path Traversal Protection

All file serving endpoints validate that requested paths stay within allowed directories:

```javascript
const resolvedPath = path.resolve(requestedPath);
if (!resolvedPath.startsWith(path.resolve(baseDir))) {
  return res.status(403).send('Forbidden');
}
```

**Protected endpoints:**
- PMTiles files: Must be in `{path}/` directory
- Styles: Must be in `styles/` directory
- Sprites: Must be in `sprites/` directory
- Fonts: Must be in `fonts/` directory

**Attacks prevented:**
```bash
# These are blocked:
GET /tiles/../../../etc/passwd.pbf
GET /styles/../../secrets.json
GET /fonts/../../.ssh/id_rsa/0-255.pbf
```

### Input Validation

**Tile Coordinates:**
```bash
# Valid formats:
6/34/22
10/530/354

# Invalid formats (rejected):
6/34          # Missing y
../../../     # Path traversal
6/abc/22      # Non-numeric
```

**Zoom Range:**
- Requests outside minZoom-maxZoom return 204 (empty)
- Prevents unnecessary processing
- Protects against extreme zoom levels

**Format Validation:**
- Vector tiles: Only `.pbf` or `.mvt`
- Raster tiles: Only `.png`, `.jpg`, `.jpeg`, `.webp`
- Mismatched format returns 400 error

---

## Error Handling

### HTTP Status Codes

| Code | Meaning | When Used | Action |
|------|---------|-----------|--------|
| 200 | OK | Tile found and served | Display tile |
| 204 | No Content | Valid request, no tile exists | Render empty |
| 400 | Bad Request | Invalid coordinates/format | Show error |
| 403 | Forbidden | Path traversal attempt | Block request |
| 404 | Not Found | Source/file not found | Show error |
| 500 | Server Error | Unexpected error | Retry or report |
| 503 | Service Unavailable | pmtiles not installed | Install tool |

### 204 vs 404: Important Distinction

**204 No Content** - Expected behavior:
- Tile coordinates are valid but tile doesn't exist in that area
- Example: Ocean tile for land-only dataset
- Client should render blank/ocean tile
- Not logged as error

**404 Not Found** - Actual error:
- Source name doesn't exist
- File path invalid
- Should be logged and investigated

---

## Usage Examples

### Downloading Map Data

**Download a single sector:**
```bash
curl -X POST "http://localhost:3000/pmtiles?tile=6/34/22"
```

**Download multiple sectors (e.g., for a sailing route):**
```bash
curl -X POST "http://localhost:3000/pmtiles?tile=6/34/22,6/35/22,6/34/23,6/35/23"
```

**Monitor download progress:**
```bash
watch -n 1 'curl -s http://localhost:3000/pmtiles/status | jq'
```

**Cancel if download is stuck:**
```bash
curl -X POST "http://localhost:3000/pmtiles/cancel"
```

**List all downloaded sectors:**
```bash
curl http://localhost:3000/pmtiles | jq '.tiles'
```

**Delete a sector you no longer need:**
```bash
curl -X DELETE "http://localhost:3000/pmtiles?tile=6/34/22"
```

### Using with MapLibre GL

**Load a pre-configured style:**
```javascript
const map = new maplibregl.Map({
  container: 'map',
  style: 'http://localhost:3000/styles/seamap-basic.json',
  center: [13, 42],  // Mediterranean
  zoom: 8
});
```

**Manually add tile sources:**
```javascript
// Add vector tiles (OpenStreetMap)
map.addSource('osm', {
  type: 'vector',
  url: 'http://localhost:3000/tiles/osm.json'
});

// Add raster tiles (Bathymetry)
map.addSource('gebco', {
  type: 'raster',
  url: 'http://localhost:3000/tiles/gebco.json'
});

// Add layer
map.addLayer({
  id: 'water',
  type: 'fill',
  source: 'osm',
  'source-layer': 'water',
  paint: {
    'fill-color': '#aad3df'
  }
});
```

### Direct Tile Access

**Download a specific tile:**
```bash
# Vector tile (MVT/PBF)
curl "http://localhost:3000/tiles/osm/8/132/88.pbf" -o tile.pbf

# Raster tile (PNG)
curl "http://localhost:3000/tiles/gebco/6/34/22.png" -o bathymetry.png
```

**Inspect TileJSON metadata:**
```bash
curl "http://localhost:3000/tiles/osm.json" | jq
```

**Check tile source header:**
```bash
curl -I "http://localhost:3000/tiles/osm/8/132/88.pbf" | grep X-Tile-Source
# X-Tile-Source: offline   (or 'online' or 'cache')
```

---

## Troubleshooting

### pmtiles CLI Not Found

**Symptom:**
```json
{
  "error": "pmtiles not installed",
  "message": "The pmtiles CLI tool is not installed on this system"
}
```

**Solution:**

macOS:
```bash
brew install protomaps/pmtiles/pmtiles
```

Linux:
```bash
wget https://github.com/protomaps/go-pmtiles/releases/latest/download/pmtiles_linux_x86_64
chmod +x pmtiles_linux_x86_64
sudo mv pmtiles_linux_x86_64 /usr/local/bin/pmtiles
```

Verify:
```bash
which pmtiles
pmtiles --version
```

### Too Many Open Files

**Symptom:**
```
Error: EMFILE: too many open files
```

**Cause:**
System limit on open file handles is too low, or PMTiles cache size is too large.

**Solution 1** - Reduce cache size:
Edit `src/tiles.js`:
```javascript
class PMTilesCache {
  constructor(maxSize = 20) {  // Reduced from 50
    // ...
  }
}
```

**Solution 2** - Increase system limits:

macOS (temporary):
```bash
ulimit -n 4096
```

Linux (permanent):
```bash
echo "* soft nofile 4096" | sudo tee -a /etc/security/limits.conf
echo "* hard nofile 4096" | sudo tee -a /etc/security/limits.conf
# Logout and login again
```

### Tiles Not Updating After Re-download

**Symptom:**
Old tiles still served after downloading new sector data.

**Cause:**
SQLite cache has newer timestamp than PMTiles file modification time.

**Solution 1** - Delete cache:
```bash
rm /path/to/tiles-cache/tiles.db
# Cache will be recreated on next request
```

**Solution 2** - Update file timestamps:
```bash
touch /path/to/pmtiles/6_34_22/*.pmtiles
# This updates modification time to current time
```

### Download Appears Stuck

**Symptom:**
Progress not advancing, status shows same values.

**Diagnosis:**
```bash
# Check if pmtiles process is running
ps aux | grep pmtiles

# Check download status
curl http://localhost:3000/pmtiles/status
```

**Solution:**
```bash
# Cancel via API
curl -X POST "http://localhost:3000/pmtiles/cancel"

# Or manually kill process
ps aux | grep pmtiles
kill <pid>

# Clean up incomplete downloads
rm -rf /path/to/pmtiles/.6_34_22
```

### Tiles Not Loading in Browser

**Symptom:**
Map shows gray or pink tiles, browser console shows errors.

**Check 1** - Verify tile source:
```bash
curl -I "http://localhost:3000/tiles/osm/8/132/88.pbf"
# Should return 200 or 204, check X-Tile-Source header
```

**Check 2** - Verify TileJSON:
```bash
curl "http://localhost:3000/tiles/osm.json"
# Should return valid JSON with tiles array
```

**Check 3** - Browser CORS:
If accessing from different origin, check CORS headers. SignalK handles this automatically, but verify in browser console.

**Check 4** - Downloaded sectors:
```bash
curl http://localhost:3000/pmtiles
# Verify sectors exist for the area you're viewing
```

### Internet Connectivity Not Detected

**Symptom:**
Tiles not fetched online even though internet is available.

**Diagnosis:**
Check connectivity status:
```bash
curl http://localhost:3000/pmtiles/status | jq
# Plugin doesn't expose isOnline directly, but you can check logs
```

**Possible causes:**
- Firewall blocking HEAD requests to PMTiles sources
- Proxy/VPN interfering with connectivity check
- Source URL changed or temporarily unavailable

**Solution:**
Wait 10 seconds for next connectivity check, or restart plugin.

---

## Development

### Adding a New Tile Source

1. **Add source definition** in `src/pmtiles.js`:
```javascript
static SOURCES() {
  return [
    // ... existing sources ...
    {
      name: 'satellite',
      url: 'https://example.com/satellite.pmtiles',
      output: 'satellite.pmtiles',
      maxzoom: 16
    }
  ];
}
```

2. **Restart plugin** - Metadata will be auto-detected on first download

3. **Download a sector:**
```bash
curl -X POST "http://localhost:3000/pmtiles?tile=6/34/22"
```

4. **Access tiles:**
```bash
GET /tiles/satellite.json
GET /tiles/satellite/{z}/{x}/{y}.png  # or .pbf depending on type
```

### Creating Custom Styles

1. **Create style JSON** in `styles/` directory:
```json
{
  "version": 8,
  "name": "My Nautical Style",
  "sources": {
    "seamap": {
      "type": "vector",
      "url": "http://localhost:3000/tiles/seamap.json"
    },
    "gebco": {
      "type": "raster",
      "url": "http://localhost:3000/tiles/gebco.json",
      "tileSize": 256
    }
  },
  "sprite": "http://localhost:3000/sprites/nautical",
  "glyphs": "http://localhost:3000/fonts/{fontstack}/{range}.pbf",
  "layers": [
    {
      "id": "ocean",
      "type": "fill",
      "source": "seamap",
      "source-layer": "water",
      "paint": {
        "fill-color": "#c8e0f4"
      }
    },
    {
      "id": "depth-contours",
      "type": "line",
      "source": "seamap",
      "source-layer": "depth_contours",
      "paint": {
        "line-color": "#4a90da",
        "line-width": 1
      }
    }
  ]
}
```

2. **Save as** `styles/my-nautical.json`

3. **Use in MapLibre:**
```javascript
style: 'http://localhost:3000/styles/my-nautical.json'
```

### Adding Custom Sprites

1. **Create sprite atlas image** (PNG)
   - Combine all icons into single image
   - Use power-of-2 dimensions (256x256, 512x512, etc.)
   - 2x version should be double resolution

2. **Create metadata JSON** with icon positions:
```json
{
  "anchor": {
    "width": 24,
    "height": 24,
    "x": 0,
    "y": 0,
    "pixelRatio": 1
  },
  "buoy-red": {
    "width": 20,
    "height": 20,
    "x": 24,
    "y": 0,
    "pixelRatio": 1
  },
  "buoy-green": {
    "width": 20,
    "height": 20,
    "x": 44,
    "y": 0,
    "pixelRatio": 1
  }
}
```

3. **Place files in** `sprites/` directory:
```
sprites/
├── nautical.json
├── nautical.png
├── nautical@2x.json
└── nautical@2x.png
```

4. **Reference in style:**
```json
{
  "sprite": "http://localhost:3000/sprites/nautical"
}
```

---

## API Reference

### Complete Endpoint List

#### Tile Serving
```
GET  /tiles/{source}.json                  - TileJSON metadata
GET  /tiles/{source}/{z}/{x}/{y}.{format}  - Individual tile
```

#### PMTiles Management
```
GET    /pmtiles         - List downloaded sectors
GET    /pmtiles/status  - Download status
POST   /pmtiles         - Start download (?tile=z/x/y)
POST   /pmtiles/cancel  - Cancel download
DELETE /pmtiles         - Delete sector (?tile=z/x/y)
```

#### Styles
```
GET /styles/{name}.json - MapLibre GL style definition
```

#### Sprites
```
GET /sprites/{name}.json     - Sprite metadata (1x)
GET /sprites/{name}.png      - Sprite image (1x)
GET /sprites/{name}@2x.json  - Sprite metadata (2x)
GET /sprites/{name}@2x.png   - Sprite image (2x)
```

#### Glyphs
```
GET /fonts/{fontstack}/{range}.pbf - Font glyphs for specific Unicode range
```

---

## License

MIT

## Contributing

Contributions welcome! Please ensure:
- Path validation for all file operations
- Proper error handling with appropriate HTTP status codes
- Resource cleanup (file handles, database connections)
- Streaming for large file responses
- Security best practices (no path traversal, input sanitization)

## Credits

- [PMTiles](https://github.com/protomaps/PMTiles) - Cloud-optimized tile archives
- [MapLibre GL](https://maplibre.org/) - Open-source map rendering
- [OpenStreetMap](https://www.openstreetmap.org/) - Map data
- [GEBCO](https://www.gebco.net/) - Bathymetry data

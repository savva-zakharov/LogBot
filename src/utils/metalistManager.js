const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const DEBUG = process.env.DEBUG_METALIST === '1' || process.env.DEBUG_METALIST === 'true';
const dlog = (...args) => { if (DEBUG) console.log('[Metalist]', ...args); };

// Paths
const CACHE_DIR = path.join(__dirname, '../../.metalist');
const CACHE_FILE = path.join(CACHE_DIR, 'metalist_cache.json');

class MetalistManager {
  constructor() {
    this.data = {};
    this.lastUpdated = null;
    this.metalistDir = CACHE_DIR;
    this.metalistFile = null;
  }

  /**
   * Save the current data to cache file
   */
  async saveToCache() {
    try {
      if (!fs.existsSync(this.metalistDir)) {
        fs.mkdirSync(this.metalistDir, { recursive: true });
      }
      
      const cacheData = {
        data: this.data,
        lastUpdated: this.lastUpdated.toISOString(),
        version: '1.0'
      };
      
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2));
      dlog('Metalist data cached successfully');
      return true;
    } catch (error) {
      console.error('Error saving metalist cache:', error);
      return false;
    }
  }

  /**
   * Load data from cache file
   */
  async loadFromCache() {
    try {
      if (!fs.existsSync(CACHE_FILE)) {
        dlog('No cache file found');
        return false;
      }
      
      const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      
      // Basic validation
      if (!cacheData.data || !cacheData.lastUpdated) {
        dlog('Invalid cache format');
        return false;
      }
      
      this.data = cacheData.data;
      this.lastUpdated = new Date(cacheData.lastUpdated);
      dlog(`Loaded metalist data from cache (last updated: ${this.lastUpdated})`);
      return true;
    } catch (error) {
      console.error('Error loading metalist cache:', error);
      return false;
    }
  }

  /**
   * Parse the CSV file and update the in-memory data
   */
  async parseMetalist() {
    try {
      const files = fs.readdirSync(this.metalistDir);
      const csvFile = files.find(file => file.toLowerCase().endsWith('.csv'));

      if (!csvFile) {
        dlog('No CSV file found in the metalist directory');
        return false;
      }

      this.metalistFile = path.join(this.metalistDir, csvFile);
      dlog(`Found metalist file: ${this.metalistFile}`);
      const fileContent = fs.readFileSync(this.metalistFile, 'utf8');
      const rows = parse(fileContent, {
        skip_empty_lines: true,
        trim: true,
        relax_quotes: true,
        relax_column_count: true,
      });

      if (rows.length < 2) {
        dlog('Metalist file is empty or has no data rows');
        return false;
      }

      // Find the header row that contains the categories
      let headerRowIndex = -1;
      const headerPattern = /^\s*,\s*,\s*Tank\s*,\s*Light Tank \(drone\/flank\)/i;
      
      for (let i = 0; i < rows.length; i++) {
        const rowStr = rows[i].join(',');
        if (headerPattern.test(rowStr)) {
          headerRowIndex = i;
          break;
        }
      }

      if (headerRowIndex === -1) {
        dlog('Could not find the header row in the CSV');
        return false;
      }

      // The header row contains categories (e.g., "", "", "Tank", "Light Tank", ...)
      const categories = rows[headerRowIndex].slice(2).map(header => header.replace(/\s*\(.*\)/g, '').trim());
      
      // Initialize data structure
      const newData = {};
      let currentBR = null;
      
      // Process each data row (starting after the header row)
      for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        
        // First column is BR, second column is the rating/suitability (Meta, Good, etc.)
        const br = row[0]?.trim();
        const rating = row[1]?.trim() || 'Unrated';
        
        // If BR is empty, use the last valid BR
        currentBR = br || currentBR;
        
        // Skip if we still don't have a valid BR
        if (!currentBR) continue;
        
        // Initialize BR in data structure if it doesn't exist
        if (!newData[currentBR]) {
          newData[currentBR] = {};
        }
        
        // Process each vehicle category (starting from column index 2)
        for (let colIndex = 2; colIndex < row.length; colIndex++) {
          const vehicle = row[colIndex]?.trim() || '';
          const category = categories[colIndex - 2]?.trim() || `Category ${colIndex - 2}`;
          
          if (!vehicle) continue;
          
          if (!newData[currentBR][category]) {
            newData[currentBR][category] = {};
          }
          
          newData[currentBR][category][rating] = vehicle;
        }
      }

      // Update the instance data if parsing was successful
      this.data = newData;
      this.lastUpdated = new Date();
      dlog(`Parsed metalist data for BRs: ${Object.keys(newData).join(', ')}`);
      return true;
    } catch (error) {
      console.error('Error parsing metalist:', error);
      return false;
    }
  }

  /**
   * Get metalist data for a specific battle rating
   * @param {string} br - The battle rating to get data for (e.g., '13.0')
   * @returns {Object|null} The metalist data for the specified BR, or null if not found
   */
  getMetalist(br) {
    return this.data[br] || null;
  }

  /**
   * Get available battle ratings
   * @returns {string[]} Array of available battle ratings
   */
  getAvailableBRs() {
    return Object.keys(this.data).sort();
  }

  /**
   * Get the most recent battle rating (highest BR)
   * @returns {string} The highest available battle rating
   */
  getLatestBR() {
    const brs = this.getAvailableBRs();
    return brs.length > 0 ? brs[brs.length - 1] : null;
  }

  /**
   * Load and parse the metalist CSV file
   */
  async loadMetalist() {
    try {
      // Ensure the directory exists
      if (!fs.existsSync(this.metalistDir)) {
        fs.mkdirSync(this.metalistDir, { recursive: true });
      }

      // Try to load from cache first
      const cacheLoaded = await this.loadFromCache();
      
      // Check if we need to refresh the data (cache is more than 24 hours old)
      const shouldRefresh = !cacheLoaded || 
                          (this.lastUpdated && 
                           (Date.now() - this.lastUpdated.getTime() > 24 * 60 * 60 * 1000));
      
      if (cacheLoaded && !shouldRefresh) {
        dlog('Using cached metalist data');
        return true;
      }
      
      dlog(shouldRefresh ? 'Refreshing metalist data...' : 'Parsing metalist data...');
      
      // Parse the CSV file
      const parseSuccess = await this.parseMetalist();
      if (parseSuccess) {
        // Save to cache for future use
        await this.saveToCache();
      } else if (cacheLoaded) {
        dlog('Using cached data due to parse error');
        return true;
      }
      
      return parseSuccess;
    } catch (error) {
      console.error('Error in loadMetalist:', error);
      // If we have cached data, use it as fallback
      if (this.lastUpdated) {
        dlog('Falling back to cached data');
        return true;
      }
      return false;
    }
  }
}

// Create and export a singleton instance
const metalistManager = new MetalistManager();

// Auto-load data on startup
metalistManager.loadMetalist().then(success => {
  if (success) {
    dlog('Metalist data loaded successfully');
  } else {
    console.warn('Failed to load metalist data on startup');
  }
});

// Refresh data every hour
setInterval(() => {
  metalistManager.loadMetalist().then(success => {
    if (success) {
      dlog('Metalist data refreshed');
    }
  });
}, 60 * 60 * 1000);

module.exports = metalistManager;

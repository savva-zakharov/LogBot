const fs = require('fs');
const path = require('path');

// Load classification data
const loadClassifications = () => {
  // Try to load comprehensive classifications first
  try {
    const compData = require('./comprehensive_vehicle_classifications.json');
    console.log('✅ Comprehensive vehicle classifications loaded');
    
    // Log vehicle counts per category
    Object.entries(compData).forEach(([category, vehicles]) => {
      console.log(`   - ${category}: ${vehicles.length} vehicles`);
    });
    
    return compData;
  } catch (e) {
    console.log('⚠️  Could not load comprehensive classifications, proceeding with empty mapping');
    return {};
  }
};

// Find all parsed_data files
const findParsedDataFiles = () => {
  try {
    const files = fs.readdirSync('.');
    return files.filter(file => file.startsWith('parsed_data') && file.endsWith('.json'));
  } catch (e) {
    console.error('❌ Error reading directory:', e.message);
    process.exit(1);
  }
};

// Load and parse a data file
const loadDataFile = (filename) => {
  try {
    const data = fs.readFileSync(filename, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    console.error(`❌ Error loading ${filename}:`, e.message);
    return null;
  }
};

// Extract unique vehicles from parsed data
const extractVehicles = (data) => {
  const vehicles = new Set();
  
  // Handle different data structures
  if (Array.isArray(data)) {
    // Old format: array of [game, squadron, player, vehicle, timestamp]
    data.forEach(entry => {
      if (entry[3]) vehicles.add(entry[3]);
    });
  } else if (typeof data === 'object' && data !== null) {
    // New format: 4D matrix {game: {squadron: {player: {vehicle: true}}}}
    Object.values(data).forEach(game => {
      if (typeof game !== 'object' || game === null) return;
      
      Object.values(game).forEach(squadron => {
        if (typeof squadron !== 'object' || squadron === null) return;
        
        Object.values(squadron).forEach(player => {
          if (typeof player !== 'object' || player === null) return;
          
          Object.keys(player).forEach(vehicle => {
            if (vehicle && vehicle !== '_gameState') {
              vehicles.add(vehicle);
            }
          });
        });
      });
    });
  }
  
  return Array.from(vehicles).filter(Boolean);
};

// Classify a vehicle name
const classifyVehicle = (vehicleName, classifications) => {
  if (!vehicleName) return 'other';
  
  const cleanName = vehicleName.trim();
  if (!cleanName) return 'other';
  
  // Check for exact matches first (case insensitive)
  for (const [type, vehicles] of Object.entries(classifications)) {
    if (type === 'other') continue;
    
    if (vehicles.some(v => v.toLowerCase() === cleanName.toLowerCase())) {
      return type;
    }
  }
  
  // Check for partial matches with scoring
  const scores = {};
  for (const [type, vehicles] of Object.entries(classifications)) {
    if (type === 'other') continue;
    
    for (const vehicle of vehicles) {
      const lowerVehicle = vehicle.toLowerCase();
      const lowerName = cleanName.toLowerCase();
      
      if (lowerName.includes(lowerVehicle) || lowerVehicle.includes(lowerName)) {
        const score = Math.min(lowerVehicle.length, lowerName.length);
        scores[type] = Math.max(scores[type] || 0, score);
      }
    }
  }
  
  // Return the best match if we have a good score
  const bestMatch = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (bestMatch && bestMatch[1] >= 3) { // Require at least 3 matching chars
    return bestMatch[0];
  }
  
  // Check for common patterns
  const patterns = {
    'bombers': [/^b-\d/i, /^il-\d/i, /^tu-\d/i, /^pe-\d/i, /^a-\d/i, /^he \d/i, /^ju \d/i, /^do \d/i],
    'tanks': [/^t-\d/i, /^m\d+/i, /^is-\d/i, /^panzer/i, /^tiger/i, /^panther/i, /^leopard/i, /^centurion/i, /^challenger/i, /^chieftain/i],
    'light_scout': [/^m\d+ /i, /^bmp/i, /^btr/i, /^pt-\d/i, /^asu-/i, /^type \d/i, /^m2[24]/i, /^m3[15]/i, /^object/i, /^stb/i, /^ru 251/i, /^t92/i],
    'fixed_wing': [/^[a-z]+-\d/i, /^[a-z]+ \d/i, /^[a-z]\d+/i, /^[a-z]{2}-\d/i],
    'helicopters': [/^[a-z]+-\d/i, /^mi-\d/i, /^ah-\d/i, /^uh-\d/i, /^ka-\d/i, /^oh-\d/i],
    'anti_air': [/aa/i, /spaa/i, /flak/i, /zsu/i, /shilka/i, /tunguska/i, /gepard/i, /type 87/i, /m163/i, /vads/i],
    'naval': [/^[a-z]{2,3}-\d/i, /^[a-z]+ \d/i, /pt-\d/i, /pr\./i, /type [a-z]\d+/i, /^[a-z]+\d+[a-z]*/i]
  };
  
  for (const [type, regexes] of Object.entries(patterns)) {
    if (regexes.some(r => r.test(cleanName))) {
      return type;
    }
  }
  
  return 'other';
};

// Process a single file
const processFile = (filename, classifications) => {
  console.log(`\n📂 Processing file: ${filename}`);
  const data = loadDataFile(filename);
  if (!data) return null;
  
  const vehicles = extractVehicles(data);
  console.log(`   Found ${vehicles.length} unique vehicles`);
  
  // Classify each vehicle
  const results = {};
  vehicles.forEach(vehicle => {
    const type = classifyVehicle(vehicle, classifications);
    if (!results[type]) results[type] = [];
    results[type].push(vehicle);
  });
  
  // Sort results by category and vehicle name
  const sortedResults = {};
  Object.keys(results).sort().forEach(key => {
    sortedResults[key] = results[key].sort();
  });
  
  return {
    filename,
    vehicleCount: vehicles.length,
    results: sortedResults,
    unclassified: sortedResults['other'] ? [...sortedResults['other']] : []
  };
};

// Generate a consolidated report
const generateReport = (fileResults) => {
  const allVehicles = new Set();
  const allResults = {};
  
  // Combine results from all files
  fileResults.forEach(fileResult => {
    Object.entries(fileResult.results).forEach(([type, vehicles]) => {
      if (!allResults[type]) allResults[type] = new Set();
      vehicles.forEach(v => {
        allVehicles.add(v);
        allResults[type].add(v);
      });
    });
  });
  
  // Convert sets to sorted arrays
  const consolidated = {};
  Object.entries(allResults).forEach(([type, vehicles]) => {
    consolidated[type] = Array.from(vehicles).sort();
  });
  
  return {
    totalVehicles: allVehicles.size,
    fileCount: fileResults.length,
    results: consolidated
  };
};

// Main function
const main = () => {
  console.log('🚀 Starting Batch Vehicle Classification Test\n');
  
  // Load data
  const classifications = loadClassifications();
  const files = findParsedDataFiles();
  
  if (files.length === 0) {
    console.log('❌ No parsed_data*.json files found in the current directory');
    process.exit(1);
  }
  
  console.log(`📂 Found ${files.length} data files to process\n`);
  
  // Process each file
  const fileResults = [];
  files.forEach(file => {
    const result = processFile(file, classifications);
    if (result) fileResults.push(result);
  });
  
  if (fileResults.length === 0) {
    console.log('❌ No valid data found in any files');
    process.exit(1);
  }
  
  // Generate consolidated report
  const report = generateReport(fileResults);
  
  // Print summary
  console.log('\n📊 Consolidated Classification Results:\n');
  console.log(`📂 Processed ${report.fileCount} files`);
  console.log(`🚗 Total unique vehicles: ${report.totalVehicles}\n`);
  
  Object.entries(report.results).forEach(([type, vehicles]) => {
    const count = vehicles.length;
    const examples = vehicles.slice(0, 3).join(', ');
    const percentage = ((count / report.totalVehicles) * 100).toFixed(1);
    console.log(`🔹 ${type.toUpperCase().padEnd(12)}: ${count.toString().padEnd(4)} vehicles (${percentage}%)`);
    console.log(`   Examples: ${examples}${count > 3 ? '...' : ''}`);
  });
  
  // Count unclassified vehicles
  const unclassified = report.results['other'] || [];
  const unclassifiedPercentage = ((unclassified.length / report.totalVehicles) * 100).toFixed(1);
  
  console.log(`\n🔍 Unclassified vehicles: ${unclassified.length} (${unclassifiedPercentage}%)`);
  if (unclassified.length > 0) {
    if (unclassified.length <= 50) {
      console.log('   Full list:');
      unclassified.forEach(v => console.log(`   - ${v}`));
    } else {
      console.log('   First 10:', unclassified.slice(0, 10).join(', '), '...');
    }
  }
  
  // Save detailed results
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputFile = `classification_batch_results_${timestamp}.json`;
  
  const output = {
    timestamp: new Date().toISOString(),
    filesProcessed: fileResults.length,
    totalUniqueVehicles: report.totalVehicles,
    unclassifiedCount: unclassified.length,
    unclassifiedPercentage: parseFloat(unclassifiedPercentage),
    unclassifiedVehicles: unclassified,
    classifications: report.results,
    fileResults: fileResults.map(f => ({
      filename: f.filename,
      vehicleCount: f.vehicleCount,
      classificationCounts: Object.entries(f.results).reduce((acc, [type, vehicles]) => {
        acc[type] = vehicles.length;
        return acc;
      }, {}),
      unclassifiedVehicles: f.unclassified
    }))
  };
  
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`\n💾 Detailed results saved to: ${path.resolve(outputFile)}`);
  
  // Also write the full unclassified list to a separate text file for convenience
  const unclassifiedFile = `unclassified_vehicles_${timestamp}.txt`;
  fs.writeFileSync(unclassifiedFile, unclassified.join('\n'), 'utf8');
  console.log(`📄 Full unclassified list saved to: ${path.resolve(unclassifiedFile)}`);
};

// Run the test
main();

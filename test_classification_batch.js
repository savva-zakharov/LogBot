const fs = require('fs');
const path = require('path');
const {
  loadClassifications,
  extractVehicles,
  classifyVehicle,
  classifyVehicleNewScheme,
  normalizeVehicleName,
} = require('./classifier');

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
    const type = classifyVehicleNewScheme(vehicle, classifications);
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
  console.log('🚀 Starting Batch Vehicle Classification Test (module-based)\n');
  
  // Load data
  const classifications = loadClassifications();
  console.log('   Categories loaded:');
  Object.entries(classifications).forEach(([cat, list]) => {
    console.log(`   - ${cat}: ${list.length} vehicles`);
  });

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

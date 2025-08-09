const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function scrapeThunderSkillVehicles() {
    console.log('🚀 Starting ThunderSkill vehicle scraper...');
    
    const browser = await puppeteer.launch({
        headless: false, // Show browser to avoid detection
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    });

    try {
        const page = await browser.newPage();
        
        // Set user agent to appear more like a real browser
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        
        console.log('📡 Navigating to ThunderSkill vehicles page...');
        await page.goto('https://thunderskill.com/en/vehicles', { 
            waitUntil: 'networkidle2',
            timeout: 30000 
        });

        console.log('⏳ Waiting for page to load...');
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Try to find vehicle data on the page
        const vehicles = await page.evaluate(() => {
            const vehicleData = {};
            
            // Look for different possible selectors for vehicle data
            const possibleSelectors = [
                '.vehicle-item',
                '.vehicle-card',
                '.vehicle-row',
                '[data-vehicle]',
                '.vehicle',
                'tr[data-vehicle-name]',
                '.table-row'
            ];
            
            for (const selector of possibleSelectors) {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    console.log(`Found ${elements.length} elements with selector: ${selector}`);
                    
                    elements.forEach((element, index) => {
                        if (index < 10) { // Log first 10 for debugging
                            console.log(`Element ${index}:`, element.textContent?.substring(0, 100));
                        }
                    });
                    break;
                }
            }
            
            // Try to extract any vehicle names and types from the page
            const allText = document.body.innerText;
            const lines = allText.split('\n');
            
            // Look for patterns that might indicate vehicle names
            const vehiclePatterns = [
                /([A-Z][a-zA-Z0-9\-\s\(\)]+)\s+(Tank|Fighter|Bomber|Helicopter|SPAA|Light|Heavy|Medium)/gi,
                /([A-Z][a-zA-Z0-9\-\s\(\)]+)\s+(Ground|Air|Naval)/gi
            ];
            
            const foundVehicles = [];
            for (const pattern of vehiclePatterns) {
                let match;
                while ((match = pattern.exec(allText)) !== null && foundVehicles.length < 50) {
                    foundVehicles.push({
                        name: match[1].trim(),
                        type: match[2].trim()
                    });
                }
            }
            
            return {
                foundVehicles,
                pageTitle: document.title,
                hasVehicleData: foundVehicles.length > 0,
                sampleText: allText.substring(0, 1000)
            };
        });

        console.log('📊 Scraping results:');
        console.log(`- Page title: ${vehicles.pageTitle}`);
        console.log(`- Found vehicles: ${vehicles.foundVehicles.length}`);
        console.log(`- Has vehicle data: ${vehicles.hasVehicleData}`);
        
        if (vehicles.foundVehicles.length > 0) {
            console.log('🎯 Sample vehicles found:');
            vehicles.foundVehicles.slice(0, 10).forEach((vehicle, index) => {
                console.log(`  ${index + 1}. ${vehicle.name} (${vehicle.type})`);
            });
        } else {
            console.log('⚠️ No vehicles found. Sample page text:');
            console.log(vehicles.sampleText);
        }

        // Save the raw data for analysis
        const outputPath = path.join(__dirname, 'thunderskill_raw_data.json');
        fs.writeFileSync(outputPath, JSON.stringify(vehicles, null, 2));
        console.log(`💾 Raw data saved to: ${outputPath}`);

        return vehicles;

    } catch (error) {
        console.error('❌ Error scraping ThunderSkill:', error);
        return null;
    } finally {
        await browser.close();
    }
}

// Run the scraper
scrapeThunderSkillVehicles()
    .then(result => {
        if (result && result.hasVehicleData) {
            console.log('✅ ThunderSkill scraping completed successfully!');
        } else {
            console.log('⚠️ ThunderSkill scraping completed but no vehicle data found.');
            console.log('💡 Consider using alternative approach or manual classification.');
        }
    })
    .catch(error => {
        console.error('💥 Scraper failed:', error);
    });

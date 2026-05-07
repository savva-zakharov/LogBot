const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Fetches the season schedule from the War Thunder forum and saves it to settings.json
 */
async function fetchSeasonSchedule() {
  try {
    // Fetch the webpage
    const response = await axios.get('https://forum.warthunder.com/t/season-schedule-for-squadron-battles/4446');
    const html = response.data;
    
    // Load HTML into cheerio for parsing
    const $ = cheerio.load(html);
    
    // Find the first post's content. Discourse usually uses .cooked class for post bodies.
    const textContent = $('.topic-post:first-child .cooked').text().trim() || 
                      $('article#post_1 .cooked').text().trim() ||
                      $('p:contains("Stepping down of BR")').parent().text().trim();
    
    if (!textContent) {
      throw new Error('Could not find schedule content on the page');
    }

    // Parse the schedule data
    const seasonSchedule = {};
    const lines = textContent.split('\n').filter(line => line.trim() !== '');
    
    const currentYear = new Date().getUTCFullYear();
    let entryCount = 0;
    
    // Regex to match: BR 14.3 (01.05 — 07.05) or мах BR 14.3 (01.05 — 07.05)
    // Supports Cyrillic 'мах/макс' or English 'max' or just 'BR'
    // Supports dots or commas for BR (e.g. 14,3)
    // Supports various dashes and flexible spacing
    const brRegex = /(?:BR|max|мах|макс)[\s:]*([\d,.]+)\s*\(\s*(\d{2})\.(\d{2})\s*[—–-]\s*(\d{2})\.(\d{2})\s*\)/i;
    
    for (const line of lines) {
      const match = line.match(brRegex);
      if (match) {
        entryCount++;
        const br = match[1].replace(',', '.'); // Normalize comma to dot
        const startDay = match[2];
        const startMonth = match[3];
        const endDay = match[4];
        const endMonth = match[5];
        
        // Construct YYYY-MM-DD. We assume current year.
        // If end month is smaller than start month, it crosses into next year.
        let startYear = currentYear;
        let endYear = currentYear;
        
        if (parseInt(endMonth) < parseInt(startMonth)) {
          // This usually happens at year rollover. 
          // If we are currently in late months, startYear is currentYear, endYear is currentYear + 1.
          // If we are currently in early months, startYear might be currentYear - 1.
          const currentMonth = new Date().getUTCMonth() + 1;
          if (currentMonth >= 11) {
            endYear = currentYear + 1;
          } else if (currentMonth <= 2) {
            startYear = currentYear - 1;
          }
        }

        const startDate = `${startYear}-${startMonth}-${startDay}`;
        const endDate = `${endYear}-${endMonth}-${endDay}`;
        
        seasonSchedule[entryCount.toString()] = {
          startDate,
          endDate,
          br
        };
      }
    }
    
    if (Object.keys(seasonSchedule).length === 0) {
      throw new Error('Parsed zero schedule entries. The forum format might have changed.');
    }
    
    // Save the raw forum text to sqbbr.txt for the /sqbbr command to use
    try {
      const sqbbrTxtPath = path.join(process.cwd(), 'sqbbr.txt');
      await fs.writeFile(sqbbrTxtPath, textContent, 'utf8');
      console.log('sqbbr.txt updated with full forum text');
    } catch (txtErr) {
      console.error('Failed to save sqbbr.txt:', txtErr);
    }
    
    // Read existing settings
    const settingsPath = path.join(process.cwd(), 'settings.json');
    let settings = {};
    try {
      const settingsContent = await fs.readFile(settingsPath, 'utf8');
      settings = JSON.parse(settingsContent);
    } catch (err) {
      // If settings.json doesn't exist, start with empty object
      console.log('settings.json not found, creating new one');
    }
    
    // Update settings with new schedule
    settings.seasonSchedule = seasonSchedule;
    
    // Write updated settings back to file
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    
    console.log('Season schedule updated successfully');
    return seasonSchedule;
  } catch (error) {
    console.error('Error fetching season schedule:', error);
    throw error;
  }
}

module.exports = { fetchSeasonSchedule };
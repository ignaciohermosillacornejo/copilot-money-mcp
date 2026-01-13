#!/usr/bin/env node
/**
 * Exploration script to understand financial_goal_history subcollection structure.
 */

import fs from 'fs';
import path from 'path';
import { homedir } from 'os';

const DB_PATH = path.join(
  homedir(),
  'Library/Containers/com.copilot.production/Data/Library',
  'Application Support/firestore/__FIRAPP_DEFAULT',
  'copilot-production-22904/main'
);

console.log('Database path:', DB_PATH);
console.log('Exists:', fs.existsSync(DB_PATH));

if (!fs.existsSync(DB_PATH)) {
  console.error('Database not found!');
  process.exit(1);
}

const files = fs.readdirSync(DB_PATH).filter(f => f.endsWith('.ldb'));
console.log(`\nFound ${files.length} .ldb files\n`);

let foundGoalHistory = false;
let sampleData = [];

for (const file of files) {
  const filepath = path.join(DB_PATH, file);
  const data = fs.readFileSync(filepath);

  // Search for financial_goal_history pattern
  if (data.includes('financial_goal_history')) {
    foundGoalHistory = true;
    console.log(`\n=== Found financial_goal_history in ${file} ===`);

    // Find all occurrences
    let pos = 0;
    while (true) {
      const idx = data.indexOf('financial_goal_history', pos);
      if (idx === -1) break;
      pos = idx + 1;

      // Extract surrounding context (500 bytes before and after)
      const start = Math.max(0, idx - 500);
      const end = Math.min(data.length, idx + 1500);
      const record = data.subarray(start, end);

      // Look for key patterns
      const hasMonth = record.includes('month');
      const hasDailyData = record.includes('daily_data');
      const hasCurrentAmount = record.includes('current_amount');
      const hasContributions = record.includes('contributions');

      if (hasMonth || hasDailyData || hasCurrentAmount) {
        console.log('\nFound record with interesting fields:');
        console.log('  - month:', hasMonth);
        console.log('  - daily_data:', hasDailyData);
        console.log('  - current_amount:', hasCurrentAmount);
        console.log('  - contributions:', hasContributions);

        // Try to extract month value
        const monthIdx = record.indexOf('month');
        if (monthIdx !== -1) {
          const afterMonth = record.subarray(monthIdx, monthIdx + 50);
          // Look for string value tag (0x8a 0x01)
          for (let i = 0; i < afterMonth.length - 10; i++) {
            if (afterMonth[i] === 0x8a && afterMonth[i + 1] === 0x01) {
              const len = afterMonth[i + 2];
              if (len > 0 && len < 20) {
                try {
                  const monthValue = afterMonth.subarray(i + 3, i + 3 + len).toString('utf-8');
                  console.log('  Month value:', monthValue);
                } catch (e) {
                  // ignore
                }
              }
            }
          }
        }

        // Save a sample
        if (sampleData.length < 3) {
          sampleData.push({
            file,
            hasMonth,
            hasDailyData,
            hasCurrentAmount,
            hasContributions,
            recordHex: record.toString('hex').substring(0, 500) // First 250 bytes in hex
          });
        }
      }
    }
  }
}

if (!foundGoalHistory) {
  console.log('\nNo financial_goal_history subcollection found in database.');
  console.log('Checking for financial_goals collection...');

  for (const file of files) {
    const filepath = path.join(DB_PATH, file);
    const data = fs.readFileSync(filepath);

    if (data.includes('financial_goals')) {
      console.log(`\nFound financial_goals in ${file}`);

      // Look for goal_id patterns
      let pos = 0;
      const goals = new Set();
      while (true) {
        const idx = data.indexOf('goal_id', pos);
        if (idx === -1) break;
        pos = idx + 1;

        // Try to extract goal_id value
        const after = data.subarray(idx, idx + 100);
        for (let i = 0; i < after.length - 10; i++) {
          if (after[i] === 0x8a && after[i + 1] === 0x01) {
            const len = after[i + 2];
            if (len > 0 && len < 50) {
              try {
                const goalId = after.subarray(i + 3, i + 3 + len).toString('utf-8');
                if (goalId && !goalId.includes('\x00')) {
                  goals.add(goalId);
                }
              } catch (e) {
                // ignore
              }
            }
          }
        }
      }

      if (goals.size > 0) {
        console.log(`\nFound ${goals.size} unique goal IDs:`);
        Array.from(goals).slice(0, 5).forEach(g => console.log('  -', g));
      }
    }
  }
}

console.log('\n=== Sample Data ===');
if (sampleData.length > 0) {
  console.log(JSON.stringify(sampleData, null, 2));
} else {
  console.log('No sample data found.');
}

console.log('\n=== Search for specific field patterns ===');
const fieldsToSearch = [
  'current_amount',
  'target_amount',
  'monthly_contribution',
  'daily_data',
  'contributions',
  'progress',
  'balance',
  'snapshot'
];

for (const field of fieldsToSearch) {
  let found = false;
  for (const file of files) {
    const filepath = path.join(DB_PATH, file);
    const data = fs.readFileSync(filepath);
    if (data.includes(field)) {
      found = true;
      break;
    }
  }
  console.log(`${field}: ${found ? '✓ Found' : '✗ Not found'}`);
}

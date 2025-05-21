/**
 * This script automatically updates configuration files to use Heroku zkLogin services
 * instead of local ones.
 */

import fs from 'fs';
import path from 'path';

// Define the service URLs
const SERVICES = {
  backend: 'https://zklogin-backend-service-ba736adc0eb8.herokuapp.com',
  frontend: 'https://zklogin-frontend-service-f74353d605f9.herokuapp.com',
  salt: 'https://zklogin-salt-service-545adc326c28.herokuapp.com'
};

// Patterns to search for in files
const PATTERNS = [
  {
    regex: /http:\/\/localhost:5001/g,
    replacement: SERVICES.backend
  },
  {
    regex: /http:\/\/localhost:5003/g,
    replacement: SERVICES.frontend
  },
  {
    regex: /http:\/\/localhost:5002/g,
    replacement: SERVICES.salt
  }
];

const EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.json', '.env'];

// Find all config files
function findConfigFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);

  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory() && file !== 'node_modules' && file !== '.git') {
      findConfigFiles(filePath, fileList);
    } else if (
      EXTENSIONS.includes(path.extname(file)) &&
      !file.includes('.min.') &&
      !file.includes('dist/')
    ) {
      fileList.push(filePath);
    }
  });

  return fileList;
}

// Update a file with the new service URLs
function updateFile(filePath) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    let updated = false;

    PATTERNS.forEach(pattern => {
      if (pattern.regex.test(content)) {
        content = content.replace(pattern.regex, pattern.replacement);
        updated = true;
      }
    });

    if (updated) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`✅ Updated: ${filePath}`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error(`❌ Error updating ${filePath}:`, error.message);
    return false;
  }
}

// Main function
function main() {
  console.log('🔍 Searching for configuration files...');
  
  // Start from the current directory
  const configFiles = findConfigFiles('.');
  console.log(`Found ${configFiles.length} files to check`);
  
  let updatedCount = 0;
  
  configFiles.forEach(file => {
    if (updateFile(file)) {
      updatedCount++;
    }
  });
  
  console.log(`\n✨ Updated ${updatedCount} files to use Heroku zkLogin services`);
  
  if (updatedCount > 0) {
    console.log('\nHeroku service URLs:');
    console.log(`- Backend: ${SERVICES.backend}`);
    console.log(`- Frontend: ${SERVICES.frontend}`);
    console.log(`- Salt: ${SERVICES.salt}`);
  } else {
    console.log('No files needed updating or no configuration files were found.');
  }
}

// Run the script
main(); 
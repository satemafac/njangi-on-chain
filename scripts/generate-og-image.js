const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');

// Function to create OG image
async function createOgImage() {
  try {
    // Create canvas with dimensions for OG image
    const width = 1200;
    const height = 630;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    // Draw background gradient
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#3B82F6'); // blue-500
    gradient.addColorStop(1, '#1E40AF'); // blue-800
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    
    // Add blue overlay at the top (decorative element)
    const overlay = ctx.createLinearGradient(0, 0, 0, 250);
    overlay.addColorStop(0, '#60A5FA');
    overlay.addColorStop(1, 'rgba(59, 130, 246, 0)');
    ctx.fillStyle = overlay;
    
    // Draw decorative shape
    ctx.beginPath();
    ctx.moveTo(0, 20);
    ctx.lineTo(1200, 20);
    ctx.lineTo(1200, 250);
    ctx.bezierCurveTo(700, 300, 500, 150, 0, 210);
    ctx.closePath();
    ctx.globalAlpha = 0.3;
    ctx.fill();
    ctx.globalAlpha = 1.0;
    
    // Load and draw logo
    const logoPath = path.join(__dirname, '../public/njangi-on-chain-logo.png');
    const logo = await loadImage(logoPath);
    
    // Draw white circle for logo background
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(600, 200, 140, 0, Math.PI * 2);
    ctx.fill();
    
    // Draw logo
    ctx.drawImage(logo, 460, 60, 280, 280);
    
    // Add title text
    ctx.fillStyle = 'white';
    ctx.font = 'bold 60px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Njangi On-Chain', 600, 420);
    
    // Add subtitle text
    ctx.font = '32px Arial, sans-serif';
    ctx.fillText('Community Savings Circles on SUI Blockchain', 600, 500);
    
    // Save the PNG
    const buffer = canvas.toBuffer('image/png');
    const outputPath = path.join(__dirname, '../public/og-image.png');
    fs.writeFileSync(outputPath, buffer);
    
    console.log('Successfully generated og-image.png');
  } catch (error) {
    console.error('Error generating og-image:', error);
  }
}

createOgImage(); 
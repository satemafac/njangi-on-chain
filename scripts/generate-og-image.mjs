import fs from 'fs';
import path from 'path';
import { createCanvas, loadImage } from 'canvas';
import { fileURLToPath } from 'url';

// ES Modules equivalent to __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    
    // Load logo
    const logoPath = path.join(__dirname, '../public/njangi-on-chain-logo.png');
    const logo = await loadImage(logoPath);
    
    // Draw white circle for logo background
    const circleRadius = 140;
    const circleCenterX = 600;
    const circleCenterY = 200;
    
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(circleCenterX, circleCenterY, circleRadius, 0, Math.PI * 2);
    ctx.fill();
    
    // Calculate logo dimensions
    let logoWidth, logoHeight;
    
    // Use 85% of the circle diameter for logo size to ensure it fits well
    const maxLogoSize = circleRadius * 1.7; 
    
    // Square-like treatment for the logo regardless of aspect ratio
    // This ensures it appears uniformly within the circle
    logoWidth = maxLogoSize;
    logoHeight = maxLogoSize;
    
    // Center the logo in the circle
    const logoX = circleCenterX - (logoWidth / 2);
    const logoY = circleCenterY - (logoHeight / 2);
    
    // Draw logo in circle (using circular clipping path for clean appearance)
    ctx.save();
    ctx.beginPath();
    ctx.arc(circleCenterX, circleCenterY, circleRadius * 0.85, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(logo, logoX, logoY, logoWidth, logoHeight);
    ctx.restore();
    
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
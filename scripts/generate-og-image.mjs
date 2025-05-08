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
    const logo = await loadImage(logoPath); // logo.width, logo.height are dimensions of this file
    
    // Draw white circle for logo background
    const circleRadius = 140; // This is the radius of the white background circle
    const circleCenterX = 600;
    const circleCenterY = 200;
    
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(circleCenterX, circleCenterY, circleRadius, 0, Math.PI * 2);
    ctx.fill();
    
    // --- New scaling logic for the logo ---
    // Assume the actual circular artwork in 'njangi-on-chain-logo.png'
    // has a diameter equal to the height of the logo file, as the logo artwork is constrained by height.
    const artworkOriginalDiameter = logo.height;
    
    // We want this artwork to perfectly fill the white circle
    const targetArtworkDiameter = circleRadius * 2;
    
    const scaleFactor = targetArtworkDiameter / artworkOriginalDiameter;
    
    const drawWidth = logo.width * scaleFactor;
    const drawHeight = logo.height * scaleFactor; // This will be targetArtworkDiameter after scaling
    
    // Calculate top-left (logoX, logoY) to center the scaled logo
    // such that the artwork within it (which is assumed to be centered in the original logo file)
    // is centered in the white circle.
    const logoX = circleCenterX - drawWidth / 2;
    const logoY = circleCenterY - drawHeight / 2;
    
    // Clipping path remains the white circle itself
    ctx.save();
    ctx.beginPath();
    ctx.arc(circleCenterX, circleCenterY, circleRadius, 0, Math.PI * 2); // Clip to the exact white circle
    ctx.clip();
    
    // Draw the scaled logo file
    // The artwork within this scaled file should now perfectly align with the clipping circle
    ctx.drawImage(logo, logoX, logoY, drawWidth, drawHeight);
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
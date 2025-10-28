FROM node:18-alpine3.19

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install dependencies (including dev for ts-node if needed)
RUN npm ci --legacy-peer-deps && \
    npm cache clean --force

# Copy everything needed for the app
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY next.config.js ./

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start application with npm
CMD ["npm", "start"] 
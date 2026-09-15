FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy Prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build application
RUN npm run build

# Expose port
EXPOSE 3150

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3150/health || exit 1

# Start application
CMD ["node", "dist/index.js"]

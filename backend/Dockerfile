# Backend Dockerfile for realtime messaging service
FROM node:20-alpine

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

WORKDIR /app

# Copy package manifests and install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY . .

# Create non-root user for runtime
RUN addgroup -g 1001 -S nodejs \
  && adduser -S appuser -u 1001 \
  && chown -R appuser:nodejs /app

USER appuser

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/api/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]

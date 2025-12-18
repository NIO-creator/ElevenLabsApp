# Stage 1: Build Stage
FROM node:20-alpine AS builder

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json (if present)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application source code
COPY server.js ./
COPY models/ ./models/

# Stage 2: Production Stage
FROM node:20-alpine AS final

# Set the environment variable for the port (Cloud Run standard)
ENV PORT 8080

# Set the working directory
WORKDIR /usr/src/app

# Copy only necessary files from the builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json .
COPY --from=builder /app/server.js .
COPY --from=builder /app/models ./models

# Command to run the service
CMD [ "npm", "start" ]

FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy app files
COPY . .

# Expose port
EXPOSE 3000

# Start dev server
CMD ["npm", "run", "dev", "--", "-H", "0.0.0.0"]

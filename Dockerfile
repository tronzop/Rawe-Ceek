FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy game files
COPY . .

# Expose ports
EXPOSE 3738 3002

# Start both servers
CMD ["sh", "-c", "npm run server & npm start"]

# Use the official Node.js 18 image as the base image
FROM node:18

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json to the working directory
COPY package.json package-lock.json ./

# Install the dependencies
RUN npm install

# Copy tsconfig.json to the working directory
COPY tsconfig.json ./

RUN npm install typescript -g

# Copy the rest of the application code to the working directory
COPY . .

# Build the TypeScript code
RUN tsc -b

EXPOSE 5000

# Start the application
CMD ["node", "dist/index.js"]

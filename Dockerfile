FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY index.html app.js styles.css server.js icon.svg manifest.webmanifest robots.txt sitemap.xml service-worker.js railway.json ./
COPY marks ./marks
COPY downloads ./downloads

ENV NODE_ENV=production
EXPOSE 3057
CMD ["npm", "start"]

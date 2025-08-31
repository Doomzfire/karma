# Node 22
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["npm","start"]

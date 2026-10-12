FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY web ./web
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY --from=build /app/web/dist ./web/dist
ENV NODE_ENV=production PORT=8080
USER node
CMD ["node", "src/index.ts"]

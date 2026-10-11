FROM node:22-alpine AS build
WORKDIR /service
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY contracts ./contracts
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine
WORKDIR /service
ENV NODE_ENV=production
COPY --from=build /service/node_modules ./node_modules
COPY --from=build /service/dist ./dist
COPY migrations ./migrations
USER node
CMD ["sh", "-c", "node dist/src/migrate.js && exec node dist/src/server.js"]

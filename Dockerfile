FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
COPY package.json ./
# Numeric, not `USER node`: the kubelet cannot read /etc/passwd from an image, so
# a named user makes it reject the pod under runAsNonRoot with "image has
# non-numeric user". 1000:1000 is the `node` user in node:22-slim.
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/index.js"]

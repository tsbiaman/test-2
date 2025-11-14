# Frontend Dockerfile for realtime messaging dashboard
FROM node:20-alpine as build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
ARG VITE_API_BASE_URL
ARG VITE_WS_URL
ARG VITE_WS_PATH
ARG VITE_APP_DEFAULT_TOKEN

ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_WS_URL=${VITE_WS_URL}
ENV VITE_WS_PATH=${VITE_WS_PATH}
ENV VITE_APP_DEFAULT_TOKEN=${VITE_APP_DEFAULT_TOKEN}
RUN npm run build

FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost/ >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]

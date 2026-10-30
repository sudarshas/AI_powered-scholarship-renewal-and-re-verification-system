FROM node:22.23.3-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html ./index.html
COPY src ./src
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.31.7-alpine3.24
COPY nginx.render.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
ENV NGINX_ENVSUBST_FILTER=^(PORT|BACKEND_HOSTPORT)$
EXPOSE 10000

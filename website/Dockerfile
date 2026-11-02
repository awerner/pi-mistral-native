# Static documentation site image.
#
# Build from the REPOSITORY ROOT, not website/ — the docs loader reads
# ../docs and the asset sync copies ../assets from the parent of the website
# project, so the build context must mirror the repository layout:
#
#   docker build -f website/Dockerfile -t pi-mistral-native-site:local .
#   docker run --rm -p 8080:80 pi-mistral-native-site:local
#
# Stage 1 builds the static site with Node; stage 2 ships only the build
# output with nginx — no Node, no docs sources in the final image.

FROM node:22-alpine AS build
WORKDIR /repo/website

# Install dependencies first so source edits do not invalidate this layer.
COPY website/package.json website/package-lock.json ./
RUN npm ci

COPY website/ ./
# Repo layout the loader and asset sync expect: docs/ and assets/ one level
# above the website project.
COPY docs/ /repo/docs/
COPY assets/ /repo/assets/
COPY README.md /repo/README.md

RUN npm run build

FROM nginx:alpine
COPY website/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/website/dist /usr/share/nginx/html
EXPOSE 80

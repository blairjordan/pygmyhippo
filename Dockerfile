FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HIPPO_ROLE=all
ARG HERMES_PACKAGE_SOURCE=workspace
ARG HERMES_PACKAGE_VERSION=0.1.1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && if [ "$HERMES_PACKAGE_SOURCE" = "registry" ]; then \
      rm -rf node_modules/pygmyhippo-hermes \
      && npm pack "pygmyhippo-hermes@${HERMES_PACKAGE_VERSION}" --pack-destination /tmp \
      && npm install --omit=dev --no-save --workspaces=false /tmp/pygmyhippo-hermes-*.tgz \
      && rm -f /tmp/pygmyhippo-hermes-*.tgz; \
    fi
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/queries ./src/queries
COPY --from=build /app/src/sql ./src/sql
COPY --from=build /app/db ./db
COPY --from=deps /app/node_modules/@dbmate/linux-x64/bin/dbmate /usr/local/bin/dbmate
EXPOSE 3000
CMD ["sh", "-c", "dbmate up && npm run start"]

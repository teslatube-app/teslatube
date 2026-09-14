FROM node:20-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates xz-utils && rm -rf /var/lib/apt/lists/*
COPY package.json ./
COPY server.js frames.js render-build.sh ./
COPY public ./public
RUN bash render-build.sh
ENV PORT=3000 FRAMES_TMP=/tmp/teslatube-frames
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=10s CMD curl -fsS http://localhost:3000/healthz || exit 1
CMD ["node", "server.js"]

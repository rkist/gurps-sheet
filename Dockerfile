# The server has no dependencies, so the image is Node plus the files it serves.
FROM node:26-alpine

LABEL org.opencontainers.image.title="GURPS Sheet" \
      org.opencontainers.image.description="Self-hosted GURPS 4e character sheet builder: runs the Roll20 GURPS sheet without Roll20." \
      org.opencontainers.image.source="https://github.com/rkist/gurps-sheet" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
# Owned by root and read-only to the server, which runs as `node`.
COPY package.json server.mjs ./
COPY public ./public
COPY GURPS ./GURPS

ENV PORT=8080
EXPOSE 8080
# The image's `node` user, by id so Kubernetes runAsNonRoot can verify it.
USER 1000:1000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["sh", "-c", "wget -q --spider http://127.0.0.1:$PORT/ || exit 1"]

CMD ["node", "server.mjs"]

FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
COPY GURPS ./GURPS
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]

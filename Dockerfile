FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s CMD wget -qO- http://localhost:8080/healthz || exit 1
CMD ["node", "server/index.js"]

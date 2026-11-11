FROM node:24-alpine
WORKDIR /gateway
COPY gateway/src ./src
COPY shared /shared
EXPOSE 8080 8081
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]

ARG PNEUMA_SPACE_NODE_IMAGE=node:24-alpine@sha256:d8d97e479cdc64f052f81f129362168717c59783ade8dcc1abd22e1cca8dbd7c
FROM ${PNEUMA_SPACE_NODE_IMAGE}
WORKDIR /runner
COPY boot.mjs package.mjs ./
USER node
EXPOSE 8080
CMD ["node", "/runner/boot.mjs"]

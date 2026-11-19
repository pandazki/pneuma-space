ARG PNEUMA_SPACE_NODE_IMAGE=node:24-alpine@sha256:d8d97e479cdc64f052f81f129362168717c59783ade8dcc1abd22e1cca8dbd7c
FROM ${PNEUMA_SPACE_NODE_IMAGE}
WORKDIR /app
COPY src/ ./src/
COPY sdk/ ./sdk/
COPY ui/ ./ui/
COPY boot.mjs ./boot.mjs
ARG PNEUMA_SPACE_IMAGE=v1
RUN mkdir -p /probe && printf '%s' "$PNEUMA_SPACE_IMAGE" > /probe/image
ENV PNEUMA_SPACE_PORT=8000
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "/app/boot.mjs"]

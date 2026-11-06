FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags=-s -o /pulse .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /pulse /pulse
EXPOSE 8000
ENTRYPOINT ["/pulse"]

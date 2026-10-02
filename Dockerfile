# --- compilação ---
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
COPY web ./web
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /planner . && mkdir /data

# --- imagem final: só o binário (cerca de 6 MB) ---
FROM scratch
COPY --from=build /planner /planner
COPY --from=build --chown=65532:65532 /data /data
USER 65532:65532
ENV DATA_DIR=/data PORT=8080
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD ["/planner", "-healthcheck"]
ENTRYPOINT ["/planner"]

FROM rust:1.94.1-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55 AS build

WORKDIR /src
COPY --from=centaeris Cargo.toml Cargo.lock rust-toolchain.toml /centaeris/
COPY --from=centaeris packages/core /centaeris/packages/core
COPY --from=centaeris packages/mcp /centaeris/packages/mcp
COPY --from=centaeris packages/model-catalog /centaeris/packages/model-catalog
COPY --from=centaeris packages/runtime /centaeris/packages/runtime
COPY --from=centaeris packages/runtime_sqlite /centaeris/packages/runtime_sqlite
COPY --from=centaeris packages/tui /centaeris/packages/tui
COPY . .
RUN cargo build --release --locked -p runtime_server

FROM docker:29-cli@sha256:27a51d5ab1cd38d9eeaba7b415b8c07bc10c31e1cf1ec8d78f6413fcfab3f44f AS docker-cli

FROM debian:12.11-slim@sha256:b1a741487078b369e78119849663d7f1a5341ef2768798f7b7406c4240f86aef

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/centaeris-runtime

COPY --from=build /src/target/release/runtime_server /usr/local/bin/runtime_server
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY LICENSE /usr/share/licenses/centaeris-workspace/LICENSE
COPY skills/system /opt/centaeris/system-skills

CMD ["runtime_server"]

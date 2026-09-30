#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
release="$root/release"
stage="$release/control-plane"
rm -rf "$stage"
mkdir -p "$stage"
cp -R "$root/src" "$root/public" "$root/coturn" "$stage/"
cp "$root/Dockerfile" "$root/docker-compose.yml" "$root/package.json" "$root/package-lock.json" "$root/.env.example" "$root/LICENSE" "$root/README.md" "$stage/"
tar -C "$stage" -czf "$release/HybridControlPlane-docker.tar.gz" .
(cd "$release" && sha256sum HybridControlPlane-docker.tar.gz > HybridControlPlane-SHA256SUMS.txt)
echo "Packaged $release/HybridControlPlane-docker.tar.gz"

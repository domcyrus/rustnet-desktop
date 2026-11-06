#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [--runtime docker|podman] [--no-cache]"
}

runtime=docker
build_options=()
while (($#)); do
  case "$1" in
    --runtime)
      if (($# < 2)) || [[ "$2" != docker && "$2" != podman ]]; then
        usage >&2
        exit 2
      fi
      runtime=$2
      shift 2
      ;;
    --no-cache) build_options+=(--no-cache); shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

if ! command -v "$runtime" >/dev/null 2>&1; then
  echo "Required tool not found: $runtime" >&2
  exit 1
fi

repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/rustnet-container.XXXXXXXX")
container_id=
cleanup() {
  if [[ -n "$container_id" ]]; then
    "$runtime" rm "$container_id" >/dev/null || true
  fi
  rm -rf -- "$temporary"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$runtime" build --pull "${build_options[@]}" \
  --tag localhost/rustnet-desktop-build --iidfile "$temporary/image-id" "$repository"
# Use the exact result of this build even if another build changes the shared tag.
container_id=$("$runtime" create "$(cat "$temporary/image-id")")
mkdir "$temporary/binaries"
"$runtime" cp "$container_id:/out/." "$temporary/binaries/"
for name in rustnet-desktop rustnet-capture-engine; do
  binary="$temporary/binaries/$name"
  if [[ ! -f "$binary" || ! -x "$binary" || -L "$binary" ]]; then
    echo "Missing or invalid container artifact: $name" >&2
    exit 1
  fi
done

# Leave previous output untouched if building, extraction or validation fails.
output="$repository/dist/linux"
mkdir -p "$output"
install -m 0755 "$temporary/binaries/rustnet-desktop" "$output/rustnet-desktop"
install -m 0755 "$temporary/binaries/rustnet-capture-engine" "$output/rustnet-capture-engine"
printf 'Built %s/rustnet-desktop\nBuilt %s/rustnet-capture-engine\n' "$output" "$output"

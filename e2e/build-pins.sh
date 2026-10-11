# Sourced by regtest-bootstrap.sh and consumer-environment-bootstrap.sh:
# loads build-pins.env and compares each build-context checkout with its pin.
#
# A checkout at another revision builds something this SDK commit was never
# proven with. Under CI (CI set, as GitHub Actions sets it) that fails the
# bootstrap; locally it is reported on stderr, because a local stack may be
# built from a fork under development on purpose.

BUILD_PINS_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/build-pins.env"
set -a
# shellcheck source=build-pins.env
. "$BUILD_PINS_FILE"
set +a

# check_build_pin <label> <checkout dir> <pinned sha>
# A directory that does not exist is not built by this stack and is skipped.
check_build_pin() {
  local label="$1" dir="$2" pinned="$3" head
  [ -d "$dir" ] || return 0
  if ! head="$(git -C "$dir" rev-parse HEAD 2>/dev/null)"; then
    echo "build-pins: $label at $dir is not a git checkout, its revision cannot be compared with $pinned" >&2
    [ -z "${CI:-}" ] || return 1
    return 0
  fi
  if [ "$head" != "$pinned" ]; then
    echo "build-pins: $label at $dir is at $head, $BUILD_PINS_FILE pins $pinned" >&2
    [ -z "${CI:-}" ] || return 1
  fi
  return 0
}

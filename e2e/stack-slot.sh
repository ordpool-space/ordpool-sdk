# Sourced by regtest-bootstrap.sh and consumer-environment-bootstrap.sh: puts
# the stack into a machine-wide slot (e2e/stack-slots.ts), so its host ports
# and compose project come from the slot and no more than
# ORDPOOL_E2E_MAX_STACKS stacks run on this machine at once.
#
#   use_stack_slot <regtest|consumer>
#
# - E2E_SLOT set (a caller acquired the slot: `scripts/e2e-slots.mjs run`, a
#   workflow's acquire step): fills in that slot's environment, keeping any
#   variable the caller already set.
# - E2E_SLOT unset: acquires a slot for this script, waiting in line while all
#   are held, and exports its environment. The running containers keep the slot
#   held after this script exits; `scripts/e2e-slots.mjs down <slot>` tears the
#   stack down and frees it. If this script fails, it tears down what it started
#   and releases the slot itself (release_stack_slot_on_failure).

STACK_SLOTS_CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/e2e-slots.mjs"
STACK_SLOT_ACQUIRED_HERE=0

use_stack_slot() {
  local kind="$1" exports
  if [ -z "${E2E_SLOT:-}" ]; then
    exports="$(node "$STACK_SLOTS_CLI" acquire --kind "$kind" --owner-pid $$ --label "$(basename "$0")" --format sh)"
    eval "$exports"
    STACK_SLOT_ACQUIRED_HERE=1
    trap release_stack_slot_on_failure EXIT
  else
    exports="$(node "$STACK_SLOTS_CLI" env --slot "$E2E_SLOT" --kind "$kind" --format sh)"
    eval "$exports"
  fi
}

# EXIT trap of a script that acquired its own slot: on failure, show what the
# stack logged, tear it down and release the slot, so a failed bring-up never
# keeps a slot or ports held. On success the slot stays with the stack.
release_stack_slot_on_failure() {
  local status=$?
  [ "$status" -ne 0 ] || return 0
  [ "$STACK_SLOT_ACQUIRED_HERE" = 1 ] || return 0
  echo "$(basename "$0"): failed with status $status; tearing down slot $E2E_SLOT ($E2E_PREFIX)" >&2
  for project in "$E2E_PREFIX-regtest" "$E2E_PREFIX-consumer"; do
    if ! docker compose -p "$project" logs --tail 40 >&2; then
      echo "$(basename "$0"): could not read the logs of $project" >&2
    fi
  done
  if ! node "$STACK_SLOTS_CLI" down "$E2E_SLOT" --force >&2; then
    echo "$(basename "$0"): teardown of slot $E2E_SLOT failed; the slot frees itself once its containers are gone (node $STACK_SLOTS_CLI list)" >&2
  fi
  exit "$status"
}

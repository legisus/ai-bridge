# Teardown of the smoke job's throwaway instance (sourced by
# test/docker-chrome-smoke.sh; tested without Docker by
# test/docker-chrome.helper.test.sh). Expects: RUN, BRIDGE_DOCKER_HOME,
# BRIDGE_DOCKER_PROJECT, BRIDGE_PUBLISH_PORT, SCREEN_PUBLISH_PORT, a function
# BD (the helper for this instance); optional SMOKE_EXTRA_IMAGES (image tags
# this run made).
#
# The rule: the scratch directories are the mounted data of this run's
# containers. They are deleted only when Docker has ANSWERED that no container
# of this run is left. A listing that failed is not an empty listing: then the
# state is unknown, the files stay, and the teardown fails.
teardown_done=0
teardown_rc=0
# ids of this run's containers on stdout; non-zero when Docker could not list them
leftovers() { docker ps -aq --filter "name=^ai-bridge-chrome-$RUN"; }
teardown() {
  local ids c img
  [ "$teardown_done" = 1 ] && return "$teardown_rc"; teardown_done=1
  if [ "${KEEP:-0}" = 1 ]; then echo "KEEP=1: $BRIDGE_DOCKER_PROJECT left running (relay 127.0.0.1:$BRIDGE_PUBLISH_PORT, screen http://127.0.0.1:$SCREEN_PUBLISH_PORT, files $BRIDGE_DOCKER_HOME)"; return 0; fi
  BD down > /dev/null 2>&1 || true
  # Only this run's own containers (name prefix ai-bridge-chrome-$RUN) are ever removed here.
  if ! ids="$(leftovers 2> /dev/null)"; then
    echo "teardown: Docker could not list the containers — whether this run's containers are gone is UNKNOWN; files kept in $BRIDGE_DOCKER_HOME" >&2
    teardown_rc=1; return 1
  fi
  for c in $ids; do docker rm -f "$c" > /dev/null 2>&1; done
  if ! ids="$(leftovers 2> /dev/null)"; then
    echo "teardown: Docker could not list the containers after the removal — UNKNOWN; files kept in $BRIDGE_DOCKER_HOME" >&2
    teardown_rc=1; return 1
  fi
  if [ -n "$ids" ]; then
    echo "teardown: containers still present ($(paste -sd, - <<< "$ids")); files kept in $BRIDGE_DOCKER_HOME" >&2
    teardown_rc=1; return 1
  fi
  for img in ${SMOKE_EXTRA_IMAGES:-}; do docker rmi "$img" > /dev/null 2>&1 || true; done
  rm -rf "$BRIDGE_DOCKER_HOME"
}

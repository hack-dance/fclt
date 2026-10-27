#!/bin/sh

set -eu

# Resolve version-manager shims while the caller's runtime configuration is available.
bun_executable=$(bun --print 'process.execPath')
node_executable=$(node --print 'process.execPath')
export PATH="$(dirname "$bun_executable"):$(dirname "$node_executable"):$PATH"

# The shared helper resolves physical ancestors and refuses unsafe roots before mkdir.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
isolation=$("$bun_executable" "$script_dir/../test/isolation-root.ts")
{
  IFS= read -r FCLT_TEST_REAL_HOME
  IFS= read -r FCLT_TEST_REAL_STATE_ROOT
  IFS= read -r test_root
} <<EOF
$isolation
EOF
export FCLT_TEST_REAL_HOME FCLT_TEST_REAL_STATE_ROOT
export NODE_ENV=test
export FCLT_TEST_SHELL_ROOT="$test_root"
export HOME="$test_root/home"
export XDG_STATE_HOME="$test_root/state"
export XDG_CONFIG_HOME="$test_root/config"
export XDG_DATA_HOME="$test_root/data"
export XDG_CACHE_HOME="$test_root/cache"
export TMPDIR="$test_root/tmp" TMP="$test_root/tmp" TEMP="$test_root/tmp"
mkdir -p "$HOME" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$TMPDIR"
export FACULT_LOCAL_STATE_DIR='~/.local/state/fclt'
export FACULT_CACHE_DIR='~/.cache/fclt'
if [ "$(uname -s)" = Darwin ]; then
  export FACULT_LOCAL_STATE_DIR='~/Library/Application Support/fclt'
  export FACULT_CACHE_DIR='~/Library/Application Support/fclt/cache'
fi
unset FACULT_ROOT_DIR FACULT_ROOT_SCOPE

unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CEILING_DIRECTORIES GIT_COMMON_DIR
unset GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_CONFIG_SYSTEM
unset GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GIT_DIR GIT_DISCOVERY_ACROSS_FILESYSTEM
unset GIT_GRAFT_FILE GIT_IMPLICIT_WORK_TREE GIT_INDEX_FILE GIT_INTERNAL_SUPER_PREFIX
unset GIT_NAMESPACE GIT_NO_REPLACE_OBJECTS GIT_OBJECT_DIRECTORY GIT_PREFIX
unset GIT_QUARANTINE_PATH GIT_REPLACE_REF_BASE GIT_SHALLOW_FILE GIT_WORK_TREE

index=0
while [ "$index" -lt 64 ]; do
  key_name="GIT_CONFIG_KEY_$index"
  value_name="GIT_CONFIG_VALUE_$index"
  unset "$key_name" "$value_name"
  index=$((index + 1))
done

if [ "${1:-}" = "--ci" ]; then
  export FACULT_TEST_SKIP_LOCAL=1
  shift
fi

exec "$bun_executable" test "$@"

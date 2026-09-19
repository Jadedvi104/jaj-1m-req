#!/usr/bin/env bash
set -euo pipefail

# Pin both version and archive hash; never execute a downloaded install script.
# Upgrade together from https://github.com/rhysd/actionlint/releases.
if ! command -v actionlint >/dev/null; then
  [[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || {
    echo 'Install actionlint 1.7.12 locally, then rerun this script.'; exit 1;
  }
  tools_dir=$(mktemp -d)
  trap 'rm -rf "$tools_dir"' EXIT
  curl --fail --silent --show-error --location --retry 3 \
    https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz \
    -o "$tools_dir/actionlint.tar.gz"
  printf '%s  %s\n' 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 \
    "$tools_dir/actionlint.tar.gz" | sha256sum --check
  tar -xzf "$tools_dir/actionlint.tar.gz" -C "$tools_dir" actionlint
  export PATH="$tools_dir:$PATH"
fi
actionlint
for script in scripts/ci/*.sh; do bash -n "$script"; done
shellcheck scripts/ci/*.sh

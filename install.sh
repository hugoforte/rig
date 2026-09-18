#!/bin/sh
# rig in one command: clone the tool, install it globally, and prove it runs.
#
#   curl -fsSL https://raw.githubusercontent.com/hugoforte/rig/main/install.sh | sh
#   sh install.sh /opt/rig                          # somewhere other than ~/rig
#   RIG_INSTALL_SOURCE=/a/local/clone sh install.sh  # clone from somewhere other than GitHub
#
# An existing checkout is left exactly as it is — no fetch, no reset, no `rig update` — so
# running this again is safe. Setting rig up is a separate, deliberate step (`rig prompt
# setup`, or a `rig init` line of your own) and never happens here.
set -eu

# C:/rig on Windows, where this runs under Git Bash and install.ps1 would have said C:\rig.
case $(uname -s) in
  MINGW*|MSYS*|CYGWIN*) default=C:/rig ;;
  *) default=$HOME/rig ;;
esac
path=${1:-$default}
source=${RIG_INSTALL_SOURCE:-https://github.com/hugoforte/rig.git}

for tool in git npm; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "rig install: $tool is not on PATH — install it and run this again" >&2
    exit 1
  }
done

if [ -e "$path/.git" ]; then
  echo "a checkout is already at $path — leaving it exactly as it is"
elif [ -d "$path" ] && [ -n "$(ls -A "$path")" ]; then
  echo "rig install: $path exists, is not a git checkout, and is not empty — pass a path of your own" >&2
  exit 1
else
  echo "cloning $source into $path"
  git clone "$source" "$path"
fi

echo "installing it globally: npm install -g $path"
npm install -g "$path"

# The install is a link to the checkout, not a copy, which is what lets `rig update` move the
# command by fast-forwarding what was just cloned.
if command -v rig >/dev/null 2>&1; then
  rig=rig
else
  prefix=$(npm prefix -g)
  # Where npm puts the command: under `bin/` on Linux and macOS, in the prefix itself on
  # Windows, where this script runs under Git Bash.
  rig=
  for candidate in "$prefix/bin/rig" "$prefix/rig"; do
    if [ -x "$candidate" ]; then rig=$candidate; break; fi
  done
  [ -n "$rig" ] || {
    echo "rig install: npm installed rig but no rig command turned up under $prefix" >&2
    exit 1
  }
  echo
  echo "$(dirname "$rig") is not on your PATH — add it, and rig works from anywhere"
fi

echo
"$rig" help

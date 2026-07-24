#!/usr/bin/env bash
# Safe git pull for Raspberry Pi (systemd timer). Runs as the repo owner.
set -euo pipefail

REPO="${MMX_REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BRANCH="${MMX_GIT_BRANCH:-main}"
REMOTE="${MMX_GIT_REMOTE:-origin}"
LOG_TAG="${MMX_GIT_LOG_TAG:-mmx-git-pull}"

restart_unit() {
    local unit="$1"
    unit="${unit%.service}"
    if ! systemctl cat "${unit}.service" &>/dev/null; then
        echo "[$LOG_TAG] Skip restart — unknown unit: $unit" >&2
        return 0
    fi
    echo "[$LOG_TAG] Restarting ${unit}.service (load new code)"
    if [ "$(id -u)" -eq 0 ]; then
        systemctl restart "${unit}.service"
    elif sudo -n systemctl restart "${unit}.service" 2>/dev/null; then
        :
    else
        echo "[$LOG_TAG] Pulled updates but could not restart ${unit}.service. Add sudoers (see docs/raspberry-pi-setup.md) or: sudo systemctl restart ${unit}" >&2
    fi
}

cd "$REPO"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "[$LOG_TAG] Not a git repository: $REPO" >&2
    exit 1
fi

BEFORE="$(git rev-parse HEAD)"
git fetch "$REMOTE" "$BRANCH"
# --autostash: Pi install/chmod tweaks must not block service start
git pull --ff-only --autostash "$REMOTE" "$BRANCH"
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
    echo "[$LOG_TAG] Already up to date ($AFTER)"
    exit 0
fi

echo "[$LOG_TAG] Updated $BEFORE -> $AFTER"
if [ -n "${MMX_RESTART_UNITS:-}" ]; then
    for unit in $MMX_RESTART_UNITS; do
        restart_unit "$unit"
    done
fi

exit 0

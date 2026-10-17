#!/usr/bin/env bash
# Remove Shop Desk from this Linux server.
#
#   sudo ./install/linux/uninstall-shopdesk.sh              # asks: keep data or delete
#   sudo ./install/linux/uninstall-shopdesk.sh --keep-data  # remove the program only
#   sudo ./install/linux/uninstall-shopdesk.sh --remove-data --yes
#
# Defaults match install-shopdesk.sh: app in /opt/shopdesk, data in /var/lib/shopdesk.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/shopdesk}"
DATA_DIR="${DATA_DIR:-/var/lib/shopdesk}"
SERVICE_NAME="${SERVICE_NAME:-shopdesk}"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
REMOVE_DATA=0
ASSUME_YES=0
DATA_CHOICE=0

say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
ok() { printf '  %-36s done\n' "$*"; }
fail() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  cat <<USAGE
Remove Shop Desk (systemd install).

  sudo $0 [--keep-data | --remove-data] [--yes]

  --keep-data    Remove the program, keep the database and backups (default prompt).
  --remove-data  Also delete the data folder (asks you to type DELETE).
  --yes          Do not ask before deleting the data folder.

Environment overrides: INSTALL_DIR, DATA_DIR, SERVICE_NAME.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-data) REMOVE_DATA=0; DATA_CHOICE=1 ;;
    --remove-data) REMOVE_DATA=1; DATA_CHOICE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --install-dir) INSTALL_DIR="${2:?}"; shift ;;
    --data-dir) DATA_DIR="${2:?}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1 (try --help)" ;;
  esac
  shift
done

[[ "${EUID}" -eq 0 ]] || fail "Run this uninstaller with sudo."
say "Shop Desk - Uninstall"

# Find the real install folder from the service if the default is not there.
if [[ ! -f "$INSTALL_DIR/server.mjs" ]]; then
  if command -v systemctl >/dev/null 2>&1; then
    EXEC_LINE="$(systemctl show -p ExecStart --value "$SERVICE_NAME.service" 2>/dev/null || true)"
    FOUND="$(printf '%s' "$EXEC_LINE" | sed -n 's/.*path=\([^ ;]*\)\/server\.mjs.*/\1/p' | head -1)"
    if [[ -n "$FOUND" && -f "$FOUND/server.mjs" ]]; then
      INSTALL_DIR="$FOUND"
    fi
  fi
fi

if [[ ! -f "$INSTALL_DIR/server.mjs" && ! -f "$UNIT_FILE" ]]; then
  printf '\nShop Desk was not found.\n'
  printf 'Looked in: %s\n' "$INSTALL_DIR"
  printf 'If you installed it elsewhere, run:\n  sudo %s --install-dir /your/shopdesk\n\n' "$0"
  exit 1
fi

say "Found Shop Desk"
printf '  Program : %s\n  Data    : %s\n  Service : %s\n' "$INSTALL_DIR" "$DATA_DIR" "$SERVICE_NAME"

# Never delete the filesystem root, /usr, /etc or a home folder directly.
safe_data_folder() {
  local folder="${1%/}"
  [[ -n "$folder" ]] || return 1
  case "$folder" in
    /|/usr|/usr/*|/etc|/etc/*|/bin|/bin/*|/sbin|/sbin/*|/boot|/boot/*|/home|/root|/var|/var/log) return 1 ;;
  esac
  return 0
}

if [[ "$DATA_CHOICE" -eq 0 && "$ASSUME_YES" -eq 0 ]]; then
  printf '\nWhat do you want to remove?\n'
  printf '  [1] The program only - keep shop data and backups  (recommended)\n'
  printf '  [2] Everything        - delete the program, shop data and backups\n'
  read -r -p 'Choose 1 or 2 [1]: ' CHOICE || true
  [[ "${CHOICE:-1}" == "2" ]] && REMOVE_DATA=1
fi

if [[ "$REMOVE_DATA" -eq 1 ]]; then
  if ! safe_data_folder "$DATA_DIR"; then
    fail "Refusing to delete $DATA_DIR automatically. Remove it yourself if it really is the shop data folder."
  fi
  say "This permanently deletes the shop database and backups"
  printf '  %s\n' "$DATA_DIR"
  [[ -f "$DATA_DIR/offsite.key" ]] && printf '  The offsite.key file is also deleted: without it, Google Drive backups cannot be opened.\n'
  if [[ "$ASSUME_YES" -eq 0 ]]; then
    read -r -p 'Type DELETE to confirm: ' ANSWER || true
    [[ "$ANSWER" == "DELETE" ]] || { printf '\nCancelled. Nothing was removed.\n'; exit 0; }
  fi
fi

say "Removing Shop Desk"
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop "$SERVICE_NAME.service" 2>/dev/null || true
  ok "Stopped the service"
  systemctl disable "$SERVICE_NAME.service" 2>/dev/null || true
  ok "Disabled automatic start"
fi
if [[ -f "$UNIT_FILE" ]]; then
  rm -f "$UNIT_FILE"
  command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload || true
  ok "Removed the systemd unit"
fi

if [[ -d "$INSTALL_DIR" ]]; then
  rm -rf "$INSTALL_DIR"
  ok "Removed the program files"
fi

if [[ "$REMOVE_DATA" -eq 1 ]]; then
  rm -rf "$DATA_DIR"
  ok "Deleted the shop data and backups"
  if id "$SERVICE_NAME" >/dev/null 2>&1; then
    userdel "$SERVICE_NAME" 2>/dev/null || true
    ok "Removed the service user"
  fi
fi

printf '\n=====================================================\n'
if [[ "$REMOVE_DATA" -eq 1 ]]; then
  printf ' Shop Desk was removed completely.\n'
  printf '=====================================================\n'
  printf ' The program, database and backups are gone.\n'
  printf ' If you still have an offsite backup in Google Drive, keep\n'
  printf ' offsite.key safe so it can be restored on another server.\n'
else
  printf ' Shop Desk has been removed.\n'
  printf '=====================================================\n'
  printf ' Your shop data was KEPT in:\n   %s\n\n' "$DATA_DIR"
  if [[ -f "$DATA_DIR/shop.sqlite3" ]]; then
    printf '   shop.sqlite3   %s\n' "$(du -h "$DATA_DIR/shop.sqlite3" | cut -f1)"
  fi
  [[ -f "$DATA_DIR/offsite.key" ]] && printf '   offsite.key    needed to open Google Drive backups\n'
  if [[ -d "$DATA_DIR/backups" ]]; then
    printf '   backups/       %s file(s)\n' "$(find "$DATA_DIR/backups" -maxdepth 1 -type f | wc -l | tr -d ' ')"
  fi
  printf '\n To install Shop Desk again, run install-shopdesk.sh.\n'
fi
printf '=====================================================\n\n'

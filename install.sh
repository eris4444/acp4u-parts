#!/usr/bin/env bash
# ACP4U Parts - one-command installer for any Linux distribution (no root needed).
#
#   curl -fsSL https://raw.githubusercontent.com/eris4444/acp4u-parts/main/install.sh | bash
#
# Running it again updates the program; your data in ~/ACP4U-Parts is never touched.
set -euo pipefail

REPO="${ACP4U_REPO:-eris4444/acp4u-parts}"
BRANCH="${ACP4U_BRANCH:-main}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DIR="$DATA_HOME/acp4u-parts"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$DATA_HOME/applications"
ICON_DIR="$DATA_HOME/icons/hicolor/scalable/apps"
FILES="index.html xlsx.js acp4u_parts.py icon.svg ACP4U-Parts-Form.xlsx"

if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=''; G=''; Y=''; R=''; C=''; N=''
fi
say()  { printf '%s\n' "${C}==>${N} ${B}$*${N}"; }
warn() { printf '%s\n' "${Y}!!${N} $*"; }
die()  { printf '%s\n' "${R}xx${N} $*" >&2; exit 1; }

printf '\n%s\n\n' "${B}ACP4U Parts${N} - customer parts requests with Excel export"
if [ "$(id -u)" -eq 0 ]; then
  warn "You are root: ACP4U Parts will be installed for the root user only. Normally run this as yourself."
fi

# ---------------------------------------------------------------- Python 3.8+
has_python() {
  command -v python3 >/dev/null 2>&1 &&
    python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1
}
if ! has_python; then
  pm=""
  if command -v apt-get >/dev/null 2>&1; then pm="apt-get update && apt-get install -y python3"
  elif command -v dnf >/dev/null 2>&1; then pm="dnf install -y python3"
  elif command -v yum >/dev/null 2>&1; then pm="yum install -y python3"
  elif command -v pacman >/dev/null 2>&1; then pm="pacman -Sy --needed --noconfirm python"
  elif command -v zypper >/dev/null 2>&1; then pm="zypper --non-interactive install python3"
  elif command -v apk >/dev/null 2>&1; then pm="apk add python3"
  elif command -v xbps-install >/dev/null 2>&1; then pm="xbps-install -Sy python3"
  elif command -v eopkg >/dev/null 2>&1; then pm="eopkg install -y python3"
  elif command -v emerge >/dev/null 2>&1; then pm="emerge --noreplace dev-lang/python"
  fi
  [ -n "$pm" ] || die "Python 3.8 or newer is required - install python3 with your package manager, then run this again."
  say "Python 3 is missing - installing it ($pm)"
  if [ "$(id -u)" -eq 0 ]; then
    sh -c "$pm"
  elif command -v sudo >/dev/null 2>&1; then
    sudo sh -c "$pm"
  else
    die "Please run as root:  $pm"
  fi
  has_python || die "Python 3.8+ is still not available."
fi

# ---------------------------------------------------------------- download
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if [ -n "${ACP4U_SRC:-}" ]; then
  say "Using local files from $ACP4U_SRC"
  for f in $FILES; do cp "$ACP4U_SRC/$f" "$TMP/" 2>/dev/null || true; done
else
  url="https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"
  say "Downloading from github.com/$REPO"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$TMP/src.tar.gz"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TMP/src.tar.gz" "$url"
  else
    python3 -c 'import sys, urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])' "$url" "$TMP/src.tar.gz"
  fi
  tar -xzf "$TMP/src.tar.gz" -C "$TMP" --strip-components=1 || die "The download is damaged - check your internet connection and try again."
fi
for f in $FILES; do
  [ -f "$TMP/$f" ] || die "Missing file in the download: $f"
done

# ---------------------------------------------------------------- install
say "Installing to $APP_DIR"
mkdir -p "$APP_DIR" "$BIN_DIR" "$DESKTOP_DIR" "$ICON_DIR"
if [ -x "$BIN_DIR/acp4u-parts" ]; then
  "$BIN_DIR/acp4u-parts" --stop >/dev/null 2>&1 || true   # an update must not keep serving the old files
fi
for f in $FILES; do cp "$TMP/$f" "$APP_DIR/$f"; done
chmod 755 "$APP_DIR/acp4u_parts.py"
cp "$TMP/icon.svg" "$ICON_DIR/acp4u-parts.svg"

cat > "$BIN_DIR/acp4u-parts" <<EOF
#!/bin/sh
exec python3 "$APP_DIR/acp4u_parts.py" "\$@"
EOF
chmod 755 "$BIN_DIR/acp4u-parts"

cat > "$DESKTOP_DIR/acp4u-parts.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=ACP4U Parts
GenericName=Parts Requests
Comment=Log customer car-parts requests and export them to Excel with photos
Exec="$BIN_DIR/acp4u-parts"
Icon=acp4u-parts
Terminal=false
Categories=Office;Database;
Keywords=excel;parts;customers;cars;acp4u;
StartupNotify=true
StartupWMClass=acp4u-parts
EOF
chmod 644 "$DESKTOP_DIR/acp4u-parts.desktop"

# a shortcut on the desktop as well, when there is one
DESK="$HOME/Desktop"
if command -v xdg-user-dir >/dev/null 2>&1; then DESK="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$DESK")"; fi
if [ -d "$DESK" ] && [ "$DESK" != "$HOME" ]; then
  cp "$DESKTOP_DIR/acp4u-parts.desktop" "$DESK/acp4u-parts.desktop"
  chmod 755 "$DESK/acp4u-parts.desktop"
  if command -v gio >/dev/null 2>&1; then gio set "$DESK/acp4u-parts.desktop" metadata::trusted true >/dev/null 2>&1 || true; fi
fi

if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q "$DESKTOP_DIR" >/dev/null 2>&1 || true; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true; fi

# ---------------------------------------------------------------- done
app_window=""
for b in google-chrome google-chrome-stable chromium chromium-browser brave-browser brave microsoft-edge microsoft-edge-stable vivaldi vivaldi-stable; do
  if command -v "$b" >/dev/null 2>&1; then app_window="$b"; break; fi
done

printf '\n%s\n' "${G}${B}ACP4U Parts is installed.${N}"
printf '  %-10s %s\n' "Open:" "ACP4U Parts in your applications menu, or run: acp4u-parts"
printf '  %-10s %s\n' "Your data:" "~/ACP4U-Parts  (Excel files in Exports/, backups in Backups/)"
printf '  %-10s %s\n' "Update:" "acp4u-parts --update"
printf '  %-10s %s\n' "Remove:" "acp4u-parts --uninstall   (your data stays)"
if [ -z "$app_window" ]; then
  warn "No Chrome/Chromium/Brave/Edge found: the app opens in your default browser. With one of them installed it gets its own app window."
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not in your PATH. The menu icon works anyway; for the command add to ~/.bashrc:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && [ -z "${ACP4U_NO_LAUNCH:-}" ]; then
  say "Starting ACP4U Parts..."
  "$BIN_DIR/acp4u-parts" >/dev/null 2>&1 &
fi

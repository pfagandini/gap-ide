#!/usr/bin/env bash
# Add GAP IDE to the app menu and to PATH (~/.local/bin/gap-ide).
#   scripts/install-desktop.sh [default-project-folder]
# The menu entry opens the given folder (default: your home directory).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
folder="$(readlink -f "${1:-$HOME}")"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icons="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
mkdir -p "$apps" "$icons" "$HOME/.local/bin"
ln -sf "$here/bin/gap-ide" "$HOME/.local/bin/gap-ide"
cp "$here/public/favicon.svg" "$icons/gap-ide.svg"
cat > "$apps/gap-ide.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=GAP IDE
Comment=Edit and run GAP files
Exec="$here/bin/gap-ide" "$folder"
Icon=gap-ide
Terminal=false
Categories=Development;Education;Math;
StartupWMClass=gap-ide
DESKTOP
update-desktop-database "$apps" 2>/dev/null || true
echo "Installed: $apps/gap-ide.desktop (opens $folder)"

#!/bin/bash
# Collects a self-contained copy of the built stream player: the exe, Qt's runtime and QML modules,
# and every MSYS2 DLL they load. Run by build-moonlight.ps1 -Package inside MSYS2 UCRT64.
#   collect-moonlight.sh <moonlight-qt source dir> <build dir>
set -euo pipefail
src="$1"
build="$2"
dist="$build/dist"

rm -rf "$dist"
mkdir -p "$dist"
cp "$build/app/release/Moonlight.exe" "$dist/"
# The build keeps debug symbols in the exe (about 80 MB of it); the shipped copy doesn't need them.
strip "$dist/Moonlight.exe"
windeployqt6 --release --no-translations --qmldir "$src/app/gui" "$dist/Moonlight.exe"
rm -rf "$dist/qmltooling"
# MSYS2's Qt looks for plugins and QML modules under share/qt6; point it at this folder's layout.
printf '[Paths]\nPrefix = .\nPlugins = .\nQmlImports = qml\n' > "$dist/qt.conf"

# ntldd lists what each binary loads. Copy whatever comes from MSYS2 and isn't there yet; a second
# pass picks up what the first pass's DLLs load in turn.
for pass in 1 2; do
    find "$dist" \( -name '*.exe' -o -name '*.dll' \) -print0 | xargs -0 ntldd -R 2>/dev/null |
        grep -i 'ucrt64' | sed -E 's/.*=> ([^ ]+) .*/\1/' | tr '\\' '/' | sort -u |
        while read -r dll; do
            if [ -f "$dll" ] && [ ! -f "$dist/$(basename "$dll")" ]; then
                cp "$dll" "$dist/"
            fi
        done || true # grep finding nothing more is fine
done
echo "Collected $(find "$dist" -type f | wc -l) files in $dist"

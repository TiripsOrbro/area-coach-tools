#!/usr/bin/env bash
# Recalculate Excel formulas in Build To JS.xlsx using LibreOffice Calc (Pi / Linux).
# Round-trip xlsx → ods → xlsx so cached formula results are written back into the file.
set -euo pipefail

FILE="${1:?Usage: recalc-workbook.sh path/to/workbook.xlsx}"
FILE="$(realpath "$FILE")"
DIR="$(dirname "$FILE")"
BASE="$(basename "$FILE" .xlsx)"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

LO="${LIBREOFFICE_BIN:-}"
if [[ -z "$LO" ]]; then
  if command -v soffice >/dev/null 2>&1; then
    LO=soffice
  elif command -v libreoffice >/dev/null 2>&1; then
    LO=libreoffice
  else
    echo "LibreOffice not found — install with: sudo apt install -y libreoffice-calc" >&2
    exit 1
  fi
fi

SRC="$WORKDIR/${BASE}.xlsx"
OUT="$WORKDIR/${BASE}.recalc.xlsx"
cp "$FILE" "$SRC"

"$LO" --headless --norestore --nologo --nodefault --nofirststartwizard \
  --convert-to ods --outdir "$WORKDIR" "$SRC" >/dev/null 2>&1

ODS="$WORKDIR/${BASE}.ods"
if [[ ! -f "$ODS" ]]; then
  echo "LibreOffice failed to open workbook: $FILE" >&2
  exit 1
fi

"$LO" --headless --norestore --nologo --nodefault --nofirststartwizard \
  --convert-to 'xlsx:"Calc MS Excel 2007 XML"' --outdir "$WORKDIR" "$ODS" >/dev/null 2>&1

if [[ -f "$WORKDIR/${BASE}.xlsx" ]]; then
  OUT="$WORKDIR/${BASE}.xlsx"
elif [[ -f "$SRC" ]]; then
  OUT="$SRC"
else
  echo "LibreOffice failed to export recalculated xlsx: $FILE" >&2
  exit 1
fi

mv "$OUT" "$FILE"
echo "Recalculated and saved: $FILE"

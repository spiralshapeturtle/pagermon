#!/bin/bash
# Rollback script - restores reader_modern.js and import.js from the most recent backup

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

restore_file() {
  local base="$1"
  local latest
  latest=$(ls -t "${SCRIPT_DIR}/${base}.bak_"* 2>/dev/null | head -1)

  if [ -z "$latest" ]; then
    echo "No backup found for ${base}"
    return 1
  fi

  cp "$latest" "${SCRIPT_DIR}/${base}"
  echo "Restored ${base} from $(basename "$latest")"
}

restore_file "reader_modern.js"
restore_file "import.js"

echo "Rollback complete."

#!/bin/bash
trap 'pkill -f "rtl_fm -d 1|node reader.js"; exit' SIGINT SIGTERM
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
while true; do
 (stdbuf -i0 -o0 -e0 rtl_fm -d 1 -f 169.65M -M fm -s 22050 -g 36.4 | \
  stdbuf -i0 -o0 -e0 multimon-ng -q -c -a FLEX -t raw /dev/stdin | \
  node "$SCRIPT_DIR/reader_modern.js") 2>&1 | while read -r line; do
   echo "$line"
   if [[ "$line" == *"cb transfer status:"* ]]; then
     pkill -f "rtl_fm -d 1"
     sleep 1
     continue 2
   fi
 done
done

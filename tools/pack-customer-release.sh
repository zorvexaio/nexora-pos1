#!/usr/bin/env bash
# يجهّز حزمة عميل نظيفة بدون أدوات البائع والمفاتيح والأرشيف التاريخي.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/../nexora-pos-customer-$(cat "$ROOT/VERSION" | tr -d '[:space:]').zip}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

rsync_cmd() {
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$@"
  else
    local src="$1"; shift
    local dest="${@: -1}"
    mkdir -p "$dest"
    cp -a "$src". "$dest"/ 2>/dev/null || cp -a "$src"/* "$dest"/
  fi
}

mkdir -p "$STAGE/nexora-pos"
cp -a "$ROOT"/. "$STAGE/nexora-pos/"

# إزالة ما لا يجب أن يصل للعميل
rm -rf "$STAGE/nexora-pos/archive" \
       "$STAGE/nexora-pos/tools/generate-license.js" \
       "$STAGE/nexora-pos/tools/private-key.pem" \
       "$STAGE/nexora-pos/tools/public-key.pem" \
       "$STAGE/nexora-pos/.git" \
       "$STAGE/nexora-pos/dist" 2>/dev/null || true

# الإبقاء على أدوات التحقق الآمنة فقط
find "$STAGE/nexora-pos/tools" -name '*regression*' -o -name '*audit*' 2>/dev/null | while read -r f; do
  : # نحتفظ باختبارات الانحدار للمطورين الميدانيين إن لزم
done

cd "$STAGE"
zip -qr -9 "$OUT" nexora-pos
echo "Customer package: $OUT"
echo "Size: $(du -h "$OUT" | cut -f1)"

#!/usr/bin/env bash
# Builds build/intercom.apk without Gradle, using the Ubuntu/Debian SDK packages:
#   sudo apt-get install android-sdk android-sdk-platform-23 dalvik-exchange
# Override SDK= or BUILD_TOOLS= for a different SDK layout.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${SDK:-/usr/lib/android-sdk}"
ANDROID_JAR="${ANDROID_JAR:-$SDK/platforms/android-23/android.jar}"
BUILD_TOOLS="${BUILD_TOOLS:-$(ls -d "$SDK"/build-tools/*/ | sort -V | tail -1)}"
AAPT="$BUILD_TOOLS/aapt"
ZIPALIGN="$BUILD_TOOLS/zipalign"
APKSIGNER="$BUILD_TOOLS/apksigner"
DX="${DX:-$(command -v dalvik-exchange || command -v dx)}"

# Keep the same key between builds: Android refuses to update an app that was
# signed with a different one. Back this file up; it is gitignored.
KEYSTORE="${KEYSTORE:-intercom.keystore}"
KS_PASS="${KS_PASS:-intercom}"

rm -rf build && mkdir -p build/gen build/classes

"$AAPT" package -f -m -M AndroidManifest.xml -S res -I "$ANDROID_JAR" -J build/gen -F build/unsigned.apk

javac -nowarn -Xlint:-options --release 8 -encoding UTF-8 -classpath "$ANDROID_JAR" -d build/classes \
  $(find src build/gen -name '*.java')

"$DX" --dex --min-sdk-version=23 --output=build/classes.dex build/classes
(cd build && "$AAPT" add -f unsigned.apk classes.dex >/dev/null)

"$ZIPALIGN" -f 4 build/unsigned.apk build/aligned.apk

if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -alias intercom -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=QR Intercom" >/dev/null 2>&1
  echo "Created signing key $KEYSTORE (keep it to be able to update the app)"
fi
"$APKSIGNER" sign --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" --out build/intercom.apk build/aligned.apk

echo "Built $(pwd)/build/intercom.apk"

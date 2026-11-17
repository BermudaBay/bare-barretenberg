#!/bin/bash
# Measures how fast the plugged-in iPhone proves: builds the prover and the example app, puts the app
# on the iPhone, runs it twice and saves the times in ios/results/. Run it from anywhere.
# The first run builds the prover, about 10-15 minutes. Later runs take a couple of minutes.
#
# Rarely needed:
#   DEVICE=<iPhone name or id>  when more than one iPhone is connected
#   TEAM=<Xcode team id>        to sign with another team than the first one Xcode knows
#   BUNDLE_ID=<app id>          if Apple says the app identifier isn't available
#   RUNS=<count>                how often the app runs, 2 by default
set -uo pipefail
cd "$(dirname "$0")"
EX=$(cd .. && pwd)
ROOT=$(cd ../.. && pwd)
BUILD=$EX/build/bench
RUNS=${RUNS:-2}
PREBUILD=prebuilds/ios-arm64/bermuda__bare-barretenberg.bare
mkdir -p "$BUILD" results

stop() { echo; echo "STOPPED: $*"; exit 1; }
# Shows the first errors in a log, or its last lines, and stops: failed <log> <what failed>
failed() {
  grep -i -E 'error[ :[]' "$1" | awk '!seen[$0]++ && n++ < 5' || tail -5 "$1"
  stop "$2 Details are in $1."
}

echo "1/6 Checking the tools"
if ! xcodebuild -version >/dev/null 2>&1; then
  [ -d /Applications/Xcode.app ] && xcode-select -p 2>/dev/null | grep CommandLineTools >/dev/null &&
    stop "Point the command line tools at Xcode: sudo xcode-select -s /Applications/Xcode.app, then run this again."
  stop "Install Xcode from the App Store, open it once, then run this again."
fi
command -v node >/dev/null && command -v npm >/dev/null || stop "Install Node.js from nodejs.org, then run this again."

echo "2/6 Preparing the prover and the app (the first time takes about 10-15 minutes)"
cd "$ROOT"
if [ ! -d node_modules ]; then
  echo "  Installing the prover's build tools"
  npm ci >"$BUILD/npm.log" 2>&1 || failed "$BUILD/npm.log" "Installing the prover's build tools failed."
fi
# Without a build directory the prebuild is used as it is. With one, it is rebuilt, which costs
# nothing when nothing changed and makes sure the code benchmarked is the code checked out.
if [ ! -f $PREBUILD ] || [ -d build/ios-arm64 ]; then
  command -v cargo >/dev/null && command -v rustup >/dev/null || stop "Install Rust from https://rustup.rs, then run this again."
  if ! rustup target list --installed 2>/dev/null | grep -x aarch64-apple-ios >/dev/null; then
    echo "  Adding Rust's iPhone target: rustup target add aarch64-apple-ios"
    rustup target add aarch64-apple-ios >"$BUILD/rustup.log" 2>&1 || failed "$BUILD/rustup.log" "Adding Rust's iPhone target failed."
  fi
  echo "  Building the prover"
  make=node_modules/.bin/bare-make
  { { [ -f build/ios-arm64/build.ninja ] || $make generate -b build/ios-arm64 -p ios -a arm64; } &&
    $make build -b build/ios-arm64 && $make install -b build/ios-arm64 --strip; } >"$BUILD/prover.log" 2>&1 ||
    failed "$BUILD/prover.log" "Building the prover failed."
fi

cd "$EX"
# npm copies the addon into node_modules (install-links in .npmrc), so a copy that differs from the
# repo's is installed again.
addon=node_modules/@bermuda/bare-barretenberg
if [ ! -d node_modules ] || ! cmp -s "$ROOT/$PREBUILD" $addon/$PREBUILD || ! cmp -s "$ROOT/package.json" $addon/package.json ||
  ! diff -r "$ROOT/src" $addon/src >/dev/null 2>&1; then
  echo "  Installing the app's packages"
  npm ci >"$BUILD/npm-app.log" 2>&1 || failed "$BUILD/npm-app.log" "Installing the app's packages failed."
fi
# As `npm run ios`, for the iPhone only. --always-multi-host keeps the xcframework layout that the
# Xcode project embeds the addons from.
echo "  Packing the app"
{ npm run bundle &&
  node_modules/.bin/bare-link --host ios-arm64 --always-multi-host --out ios/addons worklet.js &&
  node_modules/.bin/bare-pack --host ios-arm64 --linked --out ios/app.bundle worklet.js; } >"$BUILD/app.log" 2>&1 ||
  failed "$BUILD/app.log" "Packing the app failed."

echo "3/6 Finding the iPhone"
dev() { plutil -extract "result.devices.$1" raw -o - "$BUILD/devices.json" 2>/dev/null; }
find_iphone() {
  xcrun devicectl list devices --json-output "$BUILD/devices.json" >"$BUILD/devices.log" 2>&1 ||
    stop "Xcode can't list devices. Open Xcode once, then run this again."
  i=0; n=
  while id=$(dev $i.identifier); do
    name=$(dev $i.deviceProperties.name | sed 's/ *$//')
    if [ "$(dev $i.hardwareProperties.deviceType)" = iPhone ] && dev $i.connectionProperties.transportType >/dev/null &&
      { [ -z "${DEVICE:-}" ] || [ "$DEVICE" = "$id" ] || [ "$DEVICE" = "$name" ]; }; then
      [ -z "$n" ] || stop "More than one iPhone is connected. Unplug the others."
      n=$i
    fi
    i=$((i + 1))
  done
  [ -n "$n" ] || stop "No iPhone found. Plug it in with a cable and unlock it."
  id=$(dev $n.identifier)
}
find_iphone
if [ "$(dev $n.connectionProperties.pairingState)" != paired ]; then
  echo "  On the iPhone: tap Trust and enter the passcode."
  xcrun devicectl manage pair --device "$id" >"$BUILD/pair.log" 2>&1 || stop "The iPhone wasn't trusted. Unlock it and run this again."
  find_iphone
  [ "$(dev $n.connectionProperties.pairingState)" = paired ] || stop "The iPhone wasn't trusted. Unlock it and run this again."
fi
product=$(dev $n.hardwareProperties.productType)
model="$(dev $n.hardwareProperties.marketingName || echo iPhone) ($product)"
ios=$(dev $n.deviceProperties.osVersionNumber)
echo "  $model, iOS $ios"
[ "$(dev $n.deviceProperties.developerModeStatus)" = enabled ] ||
  stop "Turn on Developer Mode: on the iPhone, Settings > Privacy & Security > Developer Mode > On. It restarts; unlock it, tap Turn On, then run this again."

echo "4/6 Building the app (a few minutes the first time)"
[ -n "${TEAM:-}" ] || TEAM=$({ defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier
  defaults read com.apple.dt.Xcode IDEProvisioningTeams; } 2>/dev/null | sed -n 's/.*teamID = \([A-Z0-9]*\);.*/\1/p' | head -1)
[ -n "$TEAM" ] || stop "Add your Apple ID to Xcode: Xcode > Settings > Accounts > +. A free one works."
BUNDLE_ID=${BUNDLE_ID:-xyz.bermudabay.barretenberg.bench.$(echo "$TEAM" | tr A-Z a-z)}
build() {
  xcodebuild -project ios/BareBarretenberg.xcodeproj -scheme App -configuration Release -destination "$1" \
    -derivedDataPath "$BUILD/dd" -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
    DEVELOPMENT_TEAM="$TEAM" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" build >"$BUILD/build.log" 2>&1
}
build "id=$(dev $n.hardwareProperties.udid)" || build generic/platform=iOS || failed "$BUILD/build.log" "The build failed."

echo "5/6 Installing"
xcrun devicectl device install app --device "$id" "$BUILD/dd/Build/Products/Release-iphoneos/BareBarretenberg.app" >"$BUILD/install.log" 2>&1 ||
  { tail -3 "$BUILD/install.log"; stop "Installing failed. Unlock the iPhone and run this again."; }

sha=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null) && { git -C "$ROOT" diff --quiet HEAD || sha=$sha-dirty; } || sha=unknown
sdk=$(sed -n 's/.*"file:vendor\/bermuda-sdk-\(.*\)\.tgz".*/\1/p' package.json)
out=$EX/ios/results/$product-$(date +%Y%m%d-%H%M%S).txt
for r in $(seq 1 "$RUNS"); do
  echo "6/6 Run $r: keep the iPhone unlocked with the app open"
  log=$BUILD/run-$r.log
  xcrun devicectl device process launch --device "$id" --console --terminate-existing "$BUNDLE_ID" >"$log" 2>&1 &
  pid=$!
  for s in $(seq 600); do
    grep -q -E '"step":"(done|error)"' "$log" || ! kill -0 $pid 2>/dev/null && break
    sleep 1
  done
  kill $pid 2>/dev/null; wait $pid 2>/dev/null
  if ! grep -q '"step":"done"' "$log"; then
    tail -3 "$log"
    grep -q -E 'explicitly trusted|invalid code signature' "$log" &&
      stop "Trust the app: on the iPhone, Settings > General > VPN & Device Management > Apple Development > Trust. Then run this again."
    grep -q -i locked "$log" && stop "The iPhone is locked. Unlock it and run this again."
    stop "Run $r didn't finish. Details are in $log."
  fi
  [ -f "$out" ] || echo "$model, iOS $ios, bare-barretenberg $sha, Bermuda SDK $sdk" >"$out"
  grep '^{"step"' "$log" | sed "s/^/run $r: /" >>"$out"
done

echo
echo "$model, iOS $ios: mean of $RUNS runs"
node -e '
const times = {}
let memory = 0
for (const line of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) {
  const json = line.match(/^run \d+: (.*)/)?.[1]
  if (!json) continue
  const { step, ms, proofBytes, maxRssMiB } = JSON.parse(json)
  if (step === "done") memory = Math.max(memory, maxRssMiB)
  else if (ms !== undefined) (times[step] ??= { all: [], proofs: proofBytes !== undefined }).all.push(ms)
}
for (const [step, { all, proofs }] of Object.entries(times)) {
  const mean = Math.round(all.reduce((a, b) => a + b) / all.length)
  console.log(`  ${step.padEnd(14)}${String(mean).padStart(6)} ms${proofs ? `  (${all.length} proofs)` : ""}`)
}
console.log(`  ${"peak memory".padEnd(14)}${String(memory).padStart(6)} MiB`)
' "$out"
echo
echo "Saved in $out"

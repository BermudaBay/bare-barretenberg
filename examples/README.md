# Examples

Minimal iOS (Swift) and Android (Kotlin) apps that run the Bermuda SDK in a [Bare Kit](https://github.com/holepunchto/bare-kit) worklet and prove with `@bermuda/bare-barretenberg`: natively, on all cores, with no WebAssembly.

## Benchmark on your iPhone

You need Xcode with your Apple ID added (Xcode > Settings > Accounts > +; a free one works), [Node.js](https://nodejs.org) and Rust from [rustup.rs](https://rustup.rs).

1. Plug in the iPhone and unlock it.
2. Run `examples/ios/bench.sh`, from any directory.
3. Do what it says on the iPhone, such as tapping Trust, turning on Developer Mode or trusting the developer app, then run it again.

The first run builds the prover, which takes about 10-15 minutes; later runs take a couple of minutes. The script installs the npm packages, builds and installs the app, runs it twice and prints the mean time of each step. Each benchmark is saved in `ios/results/`: a line naming the iPhone, its iOS and the versions of bare-barretenberg and the SDK, then each run's raw times. `RUNS=5` runs the app five times; `DEVICE`, `TEAM` and `BUNDLE_ID` pick the iPhone, the Xcode team and the app identifier. The script links and packs the app for devices only, so run `npm run ios` before using the simulator.

## How the pieces connect

```
App.swift / MainActivity.kt         the native app: starts the worklet, sends it a directory, shows what it reports
└── app.bundle                      the worklet (worklet.js, packed by bare-pack)
    ├── @bermuda/sdk                proves through @noir-lang/noir_js and bb.js ...
    └── @bermuda/bare-barretenberg  ... which this addon stands in for; bare-link links it into the app
```

1. `npm run bundle` has esbuild bundle `app.js` with the SDK and its dependencies into `build/app.cjs`, in CommonJS (see [iOS](#ios) for why). `worklet.js` reports uncaught errors to the app, sets up Bare's Node.js globals (`globals.js`), and `main.js` loads the bundle with the import map `@bermuda/bare-barretenberg/imports`, which hands the SDK this addon in place of `@noir-lang/noir_js` and gives bb.js and ethers what they import from Node.js.
2. `app.js` points `Barretenberg.new` at `createBarretenberg()` before the first proof, so the SDK's prover runs on native barretenberg.
3. `app.js` calls `prefetch({ dir })` first, which downloads the CRS once into the app's storage, then the SDK's `warmup()`, which loads barretenberg and the circuits with their verification keys: both off the proving path. The app sends `dir` as its first IPC message.

The worklet then proves a shield (`transact2x4`) and a three-input transfer (`transact4x8`) with the SDK's prover, three times each, and reports each proof's time and the peak memory.

## Running

```sh
npm install
```

The SDK comes from [`vendor/`](vendor), so no access to its repository is needed.

### iOS

```sh
npm run ios
open ios/BareBarretenberg.xcodeproj
```

`npm run ios` bundles the app, links the worklet's native addons into `ios/addons` as xcframeworks (bare-link), and packs `ios/app.bundle` (bare-pack `--linked`). The project's "Embed addons" build phase embeds and signs whatever is in `ios/addons`. To run on a device, set a signing team in Xcode; a personal (free) team works.

The app runs its worklet on Bare Kit's JavaScriptCore engine (`ios/Engine`) rather than V8. V8 reserves 4 GiB of address space for its compressed pointers when a worklet starts, which iPhones with 4 GB of memory grant only to apps signed with the Extended Virtual Addressing entitlement, and personal teams cannot sign that. Bare's JavaScriptCore loads no ES modules and has no `SharedArrayBuffer`, hence the CommonJS bundle and the Node.js globals without `Worker`. Proving runs natively either way.

On an iPhone 11 Pro Max (A13, 4 GB), after a 1.1 s warmup, a shield (`transact2x4`) proves in 1.35 s and a three-input transfer (`transact4x8`) in 2.06 s, witness included; the app peaks at 506 MiB.

### Android

```sh
npm run android
```

Then open `android/` in Android Studio, or run `gradle installDebug` there. `npm run android` bundles the app, links the addons into `android/app/src/main/addons/<abi>/` and packs `android/app/src/main/assets/app.bundle`. The Android app is untested.

## Notes

- The apps run on arm64 devices, the iOS simulator on Apple silicon, and arm64 and x86_64 Android emulators. barretenberg has no build for the x64 iOS simulator.
- Bare Kit comes from [bare-kit-swift](https://github.com/holepunchto/bare-kit-swift) 2.4.0 and [bare-kit-kotlin](https://github.com/holepunchto/bare-kit-kotlin) v0.2.6, both on Bare 1.37, which the addon and Bare's own modules require.
- `vendor/bermuda-sdk-0.3.7-arc-2f52e09c.tgz` is `@bermuda/sdk` at commit 2f52e09c, under its own license (BUSL-1.1, in the archive).
- `fixtures/` holds inputs that the SDK's test harness built for its test chain (31337), whose circuits ship inside the SDK. `app.js` bundles those two circuits and hands them to the SDK through `circuitsBaseUrl`. On a deployed chain, the SDK fetches its circuits from `config.artifacts`: pass them to `prefetch()` as `files` and set `globalThis.fetch = cachedFetch(dir)`, so they are read from the app's storage too.

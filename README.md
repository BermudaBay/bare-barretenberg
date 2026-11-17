# bare-barretenberg

Noir witness generation and multithreaded barretenberg proving for [Bare](https://github.com/holepunchto/bare) on iOS and Android, natively and without WebAssembly.

Bare runs V8 without a JIT on iOS, so `WebAssembly` is not available there. Even where it is, Bare cannot share a WebAssembly memory between threads, so bb.js would prove on a single thread. This addon replaces both WebAssembly parts of proving:

- `Noir` runs Noir's ACVM natively (the noir crates of Noir 1.0.0). It is a drop-in for `Noir` from `@noir-lang/noir_js` 1.0.0 and yields the same witness bytes, gzipped only when read; `uncompressedWitness` is the witness stack as barretenberg reads it.
- `createBarretenberg()` gives a bb.js `Barretenberg` over the native barretenberg library of aztec-packages 6.0.0, which proves on all cores. It is meant for `@aztec-foundation/bb.js` 6.0.0, the same release.

## Usage

```js
const { Barretenberg, UltraHonkBackend } = require('@aztec-foundation/bb.js')
const { Noir, createBarretenberg, prefetch } = require('@bermuda/bare-barretenberg')

// At app start, off the proving path: download the CRS into the app's storage. What is cached
// already is kept, so this costs a few file checks on later starts.
await prefetch({ dir })

// Once per process: one native barretenberg. Once per circuit: its Noir and its backend.
const api = await createBarretenberg(Barretenberg, { dir })
const noir = new Noir(circuit)
const backend = new UltraHonkBackend(circuit.bytecode, api)

// Per proof: the witness, then a zero-knowledge UltraHonk proof for the Solidity verifier.
const { witness } = await noir.execute(inputs)
const { proof, publicInputs } = await backend.generateProof(witness, { verifierTarget: 'evm' })
```

`verifierTarget: 'evm'` is the zero-knowledge proof that barretenberg's Solidity verifiers check; `'evm-no-zk'` would leave out the zero knowledge.

`generateProof` recomputes the circuit's verification key in every proof and gunzips the witness again. Proving as the Bermuda SDK does skips both, about a quarter of each proof:

```js
// The settings verifierTarget 'evm' stands for.
const settings = { ipaAccumulation: false, oracleHashType: 'keccak', disableZk: false, optimizedSolidityVerifier: false }

// Once per circuit. A circuit that ships its key needs no computation: the Bermuda SDK's carry it as
// `verification_key`, base64.
const bytecode = pako.ungzip(Buffer.from(circuit.bytecode, 'base64'))
const { bytes: verificationKey } = await api.circuitComputeVk({ circuit: { name: 'circuit', bytecode }, settings })

// Per proof: `proof` holds the proof's field elements, `publicInputs` the public inputs, 32 bytes each.
const { uncompressedWitness } = await noir.execute(inputs)
const { proof, publicInputs } = await api.circuitProve({
  witness: uncompressedWitness,
  circuit: { name: 'circuit', bytecode, verificationKey },
  settings
})
```

### Prefetching

`prefetch({ dir, crs, files })` fills `dir` with what proving needs:

- `crs`: `{ srsSize = 2 ** 18 }`, or `false`. The SRS is one list of points, and a circuit of size 2^k uses its first 2^k, so 2^18 points cover every circuit of the Bermuda SDK.
- `files`: other URLs to cache, such as circuit artifacts. `cachedFetch(dir)` is a `fetch()` that answers from the cache for those and fetches anything else.

`createBarretenberg()` loads the SRS from `dir`, and keeps the points barretenberg decompresses there, so each later start skips the decompression. The files are the ones bb.js 6.0.0 caches.

### With the Bermuda SDK

The SDK proves with `@noir-lang/noir_js` and `Barretenberg.new()`, and fetches circuit artifacts with `fetch()`. Import the code that uses it with this package's import map, which hands the SDK this addon in place of `@noir-lang/noir_js` and gives bb.js and ethers what they import from Node.js under Bare:

```js
import './app.js' with { imports: '@bermuda/bare-barretenberg/imports' }
```

Then, before the first proof, point bb.js at the native backend:

```js
Barretenberg.new = (options) => createBarretenberg(Barretenberg, { ...options, dir })
```

To read a deployed chain's circuits from the app's storage too, prefetch them as `files` and set `globalThis.fetch = cachedFetch(dir)`.

[`examples/`](examples) shows the whole wiring in an iOS and an Android app. To see how fast your iPhone proves, plug it in and run `examples/ios/bench.sh` ([more](examples/README.md#benchmark-on-your-iphone)).

## Proving times

The Bermuda SDK at 2f52e09c proved a deposit, a transfer and a withdrawal, each on its smallest circuit:

- **iPhone**: natively with this addon, on an iPhone 14 Pro Max (A16, 6 GB, iOS 27.2.1), timed by `examples/ios/bench.sh`.
- **Browser**: in WebAssembly, as the SDK proves in a web app: noir_js 1.0.0 and bb.js 6.0.0 on 9 threads, in headless Chromium 151 on a MacBook Pro (M1 Pro, 10 cores, 16 GB, macOS 27.0.1). The page did what the iPhone app does, served cross-origin isolated so that bb.js could use threads.

Each time is the mean of six proofs over two runs, witness generation included. A circuit is loaded once, before its first proof; the transfer reuses the circuit the deposit loaded:

| Proof        | Circuit           | iPhone proof | iPhone load | Browser proof | Browser load |
| ------------ | ----------------- | -----------: | ----------: | ------------: | -----------: |
| deposit      | `transact2x4`     |       830 ms |      278 ms |        989 ms |        41 ms |
| transfer     | `transact2x4`     |       844 ms |           – |        851 ms |            – |
| withdraw     | `withdraw2x2`     |       730 ms |      243 ms |        735 ms |        29 ms |

In the browser, the first proof after the page loads takes 1.23–1.26 s while the WebAssembly warms up, which raises the deposit's mean; later 2x4 proofs take about 0.85 s.

Starting barretenberg with the CRS already cached takes 38 ms on the iPhone and 396 ms in the browser, which also compiles the WebAssembly and starts its workers. On the iPhone's first start after an install, downloading the CRS took 1.47 s and loading it 535 ms, as barretenberg decompressed its points once; the browser's first start took 1.52 s, download included. At its peak, the iPhone app uses 730 MiB and the browser's page 931 MiB (its renderer process, sampled every 250 ms).

## Building

Prebuilds are built per target with [bare-make](https://github.com/holepunchto/bare-make):

```sh
npm install
bare-make generate --platform ios --arch arm64
bare-make build
bare-make install
```

The targets are `ios-arm64`, `ios-arm64-simulator`, `android-arm64`, `android-x64` and `darwin-arm64` (for the tests). A build needs:

- Rust 1.89 with the target's standard library (`rustup target add aarch64-apple-ios` and so on),
- Xcode for iOS and macOS,
- for Android, an NDK in `ANDROID_HOME` or `ANDROID_NDK_HOME`, and [zig](https://ziglang.org) 0.15.1. Aztec builds barretenberg with zig, against zig's libc++, which the NDK's libc++ cannot stand in for, so the addon links zig's.

The barretenberg libraries are downloaded from the aztec-packages v6.0.0 release and checked against pinned SHA-256 hashes.

## Testing

```sh
bare-make generate && bare-make build && bare-make install
npm test
```

The tests run on macOS with `WebAssembly` removed, as on iOS. They execute a small circuit (`test/circuit`), compare the witness with nargo 1.0.0's, prefetch the CRS, and prove and verify.

## License

[BUSL-1.1](./LICENSE). Third-party code keeps its own license; see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

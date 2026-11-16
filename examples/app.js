// The Bermuda SDK proving through @bermuda/bare-barretenberg: natively, on all cores, with no
// WebAssembly. Three things connect them:
//
// 1. The addon's import map (see main.js) hands the SDK this package in place of
//    @noir-lang/noir_js, so witnesses are generated natively.
// 2. Barretenberg.new is pointed at the native backend before the first proof.
// 3. prefetch() fills the app's storage with the CRS once, and the SDK's warmup() loads the
//    circuits, both off the proving path.
//
// esbuild bundles this file with the SDK into build/app.cjs (`npm run bundle`).
import { Barretenberg } from '@aztec-foundation/bb.js'
import { createBarretenberg, prefetch } from '@bermuda/bare-barretenberg'
import { initProver } from '@bermuda/sdk/internal'

// The SDK loads its test chain's (31337) circuits from its own files with a dynamic import, which
// a CommonJS bundle cannot do, so the two proven here are bundled and handed to it as if fetched.
// On a deployed chain, the SDK fetches its circuits from `config.artifacts`: prefetch those as
// `files` and set `globalThis.fetch = cachedFetch(dir)`, so they are read from the app's storage.
import transact2x4 from './node_modules/@bermuda/sdk/build/src/circuits/31337/transact2x4.json' with { type: 'json' }
import transact4x8 from './node_modules/@bermuda/sdk/build/src/circuits/31337/transact4x8.json' with { type: 'json' }

import shield from './fixtures/shield-2x4.json' with { type: 'json' }
import transfer from './fixtures/transfer-4x8.json' with { type: 'json' }

const IPC = Bare.IPC ?? BareKit.IPC
const report = (message) => IPC.write(JSON.stringify(message) + '\n')

// The host's first message is the directory the app keeps its files in.
IPC.once('data', async (data) => {
  try {
    const dir = data.toString().trim()

    let start = Date.now()
    await prefetch({ dir })
    report({ step: 'prefetch', ms: Date.now() - start })

    Barretenberg.new = (options) => createBarretenberg(Barretenberg, { ...options, dir })

    const circuits = { 'bundle:/31337/transact2x4.json': transact2x4, 'bundle:/31337/transact4x8.json': transact4x8 }
    const fetch = globalThis.fetch
    globalThis.fetch = async (url, init) => (url in circuits ? { ok: true, json: async () => circuits[url] } : fetch(url, init))

    const prover = initProver({ chainId: 31337n, circuitsBaseUrl: 'bundle:' })

    // Also off the proving path: barretenberg, and each circuit with its verification key.
    start = Date.now()
    await prover.warmup(['transact2x4', 'transact4x8'])
    report({ step: 'warmup', ms: Date.now() - start })

    for (const [step, prove, { inputs }] of [
      ['shield 2x4', prover.prove2x4, shield],
      ['transfer 4x8', prover.prove4x8, transfer]
    ]) {
      for (let i = 0; i < 3; i++) {
        start = Date.now()
        const { proof } = await prove(inputs)
        report({ step, ms: Date.now() - start, proofBytes: proof.length })
      }
    }

    report({ step: 'done', maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) })
  } catch (err) {
    report({ step: 'error', message: String(err?.stack ?? err) })
  }
})

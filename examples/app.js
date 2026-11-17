// The Bermuda SDK proving through @bermuda/bare-barretenberg: natively, on all cores, with no
// WebAssembly. Three things connect them:
//
// 1. The addon's import map (see main.js) hands the SDK this package in place of
//    @noir-lang/noir_js, so witnesses are generated natively.
// 2. Barretenberg.new is pointed at the native backend before the first proof.
// 3. prefetch() fills the app's storage with the CRS once, and the SDK's warmup() loads
//    barretenberg and each circuit, both off the proving path.
//
// esbuild bundles this file with the SDK into build/app.cjs (`npm run bundle`).
import { Barretenberg } from '@aztec-foundation/bb.js'
import { createBarretenberg, prefetch } from '@bermuda/bare-barretenberg'
import { initProver } from '@bermuda/sdk/internal'

// The SDK loads its test chain's (31337) circuits from its own files with a dynamic import, which
// a CommonJS bundle cannot do, so the ones proven here are bundled and handed to it as if fetched.
// On a deployed chain, the SDK fetches its circuits from `config.artifacts`: prefetch those as
// `files` and set `globalThis.fetch = cachedFetch(dir)`, so they are read from the app's storage.
import transact2x4 from './node_modules/@bermuda/sdk/build/src/circuits/31337/transact2x4.json' with { type: 'json' }
import transact4x8 from './node_modules/@bermuda/sdk/build/src/circuits/31337/transact4x8.json' with { type: 'json' }
import transact2x16 from './node_modules/@bermuda/sdk/build/src/circuits/31337/transact2x16.json' with { type: 'json' }
import transact16x4 from './node_modules/@bermuda/sdk/build/src/circuits/31337/transact16x4.json' with { type: 'json' }
import withdraw2x2 from './node_modules/@bermuda/sdk/build/src/circuits/31337/withdraw2x2.json' with { type: 'json' }
import withdraw16x2 from './node_modules/@bermuda/sdk/build/src/circuits/31337/withdraw16x2.json' with { type: 'json' }
import withdrawDox2x2 from './node_modules/@bermuda/sdk/build/src/circuits/31337/withdrawDox2x2.json' with { type: 'json' }
import withdrawDox16x2 from './node_modules/@bermuda/sdk/build/src/circuits/31337/withdrawDox16x2.json' with { type: 'json' }

import deposit2x4 from './fixtures/deposit-2x4.json' with { type: 'json' }
import deposit4x8 from './fixtures/deposit-4x8.json' with { type: 'json' }
import deposit2x16 from './fixtures/deposit-2x16.json' with { type: 'json' }
import transfer2x4 from './fixtures/transact-2x4.json' with { type: 'json' }
import transfer4x8 from './fixtures/transact-4x8.json' with { type: 'json' }
import transfer2x16 from './fixtures/transact-2x16.json' with { type: 'json' }
import transfer16x4 from './fixtures/transact-16x4.json' with { type: 'json' }
import withdrawal2x2 from './fixtures/withdraw-2x2.json' with { type: 'json' }
import withdrawal16x2 from './fixtures/withdraw-16x2.json' with { type: 'json' }
import doxWithdrawal2x2 from './fixtures/withdraw-dox-2x2.json' with { type: 'json' }
import doxWithdrawal16x2 from './fixtures/withdraw-dox-16x2.json' with { type: 'json' }

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

    const circuits = { transact2x4, transact4x8, transact2x16, transact16x4, withdraw2x2, withdraw16x2, withdrawDox2x2, withdrawDox16x2 }
    const bundled = new Map(Object.entries(circuits).map(([name, circuit]) => [`bundle:/31337/${name}.json`, circuit]))
    const fetch = globalThis.fetch
    globalThis.fetch = async (url, init) => (bundled.has(url) ? { ok: true, json: async () => bundled.get(url) } : fetch(url, init))

    const prover = initProver({ chainId: 31337n, circuitsBaseUrl: 'bundle:' })

    // Also off the proving path: barretenberg, and below each circuit with its verification key.
    start = Date.now()
    await prover.warmup()
    report({ step: 'warmup', ms: Date.now() - start })

    // Every shape the SDK deposits, transfers and withdraws on. A deposit to one owner proves on
    // 2x4, of five to eight outputs to one owner on 4x8, and to more owners on 2x16.
    const loaded = new Set()
    for (const [step, prove, { circuit, inputs }] of [
      ['deposit 2x4', prover.prove2x4, deposit2x4],
      ['deposit 4x8', prover.prove4x8, deposit4x8],
      ['deposit 2x16', prover.prove2x16, deposit2x16],
      ['transfer 2x4', prover.prove2x4, transfer2x4],
      ['transfer 4x8', prover.prove4x8, transfer4x8],
      ['transfer 2x16', prover.prove2x16, transfer2x16],
      ['transfer 16x4', prover.prove16x4, transfer16x4],
      ['withdraw 2x2', prover.withdraw2x2, withdrawal2x2],
      ['withdraw 16x2', prover.withdraw16x2, withdrawal16x2],
      ['withdrawDox 2x2', prover.withdrawDox2x2, doxWithdrawal2x2],
      ['withdrawDox 16x2', prover.withdrawDox16x2, doxWithdrawal16x2]
    ]) {
      // The prover keeps only the four circuits it used last, so each is loaded before its proofs,
      // which costs nothing while the prover still holds it. Its first load is reported.
      start = Date.now()
      await prover.warmup([circuit])
      if (!loaded.has(circuit)) {
        report({ step, circuit, loadMs: Date.now() - start })
        loaded.add(circuit)
      }
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

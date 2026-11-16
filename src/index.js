const binding = require.addon('..', __filename)
const { prefetch, cachedFetch, loadSrs } = require('./cache')

// Calls into each native library run one at a time: barretenberg keeps its request state in a
// global, and both already use every core for a single call.
let queue = Promise.resolve()

function serial(fn, ...args) {
  const result = queue.then(() => new Promise((resolve, reject) => fn(...args, (err, out) => (err ? reject(err) : resolve(out)))))
  queue = result.catch(() => {})
  return result
}

/** A bb.js `IMsgpackBackendAsync` over native barretenberg: `new Barretenberg(new Backend(), options)`. */
class Backend {
  async call(input) {
    return new Uint8Array(await serial(binding.bbapi, input))
  }

  async destroy() {}
}

/** Drop-in for `Noir` from `@noir-lang/noir_js`: `execute()` runs Noir's ACVM natively, no WebAssembly. */
class Noir {
  constructor(circuit) {
    this.circuit = circuit
    this.bytecode = Buffer.from(circuit.bytecode, 'base64')
    this.abi = Buffer.from(JSON.stringify(circuit.abi))
  }

  async execute(inputs) {
    const out = Buffer.from(
      await serial(binding.execute, this.bytecode, this.abi, Buffer.from(JSON.stringify(inputs)))
    )
    const length = out.readUInt32LE(0)

    return {
      witness: new Uint8Array(out.subarray(4, 4 + length)),
      returnValue: JSON.parse(out.subarray(4 + length).toString())
    }
  }
}

/**
 * A bb.js `Barretenberg` that proves natively, with the SRS loaded from `dir` (see `prefetch()`,
 * which this runs first for the CRS alone and which returns at once when it is cached). Pass
 * bb.js's own class, so that this package needs no bb.js of its own.
 */
async function createBarretenberg(Barretenberg, options) {
  const { dir, srsSize } = options

  await prefetch({ dir, crs: { srsSize } })

  const api = new Barretenberg(new Backend(), options)
  await loadSrs(api, { dir, srsSize })
  return api
}

module.exports = { Backend, Noir, createBarretenberg, prefetch, cachedFetch }

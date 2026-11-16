// Runs without WebAssembly, as Bare does on iOS: witness generation and proving must be native.
delete globalThis.WebAssembly

require('bare-node-runtime/global')

const test = require('brittle')
const { Noir, createBarretenberg, prefetch, cachedFetch } = require('..')

const node = (specifier) => require(specifier, { with: { imports: 'bare-node-runtime/imports' } })
const { Barretenberg, UltraHonkBackend } = node('@aztec-foundation/bb.js')

// test/circuit, compiled and executed with nargo 1.0.0 (whose witness noir_js 1.0.0 matches).
const circuit = require('./circuit/target/circuit.json')
const nargoWitness = require('./circuit/target/circuit.gz', { with: { type: 'binary' } })
const inputs = { x: '1000', y: '7' }
const dir = `${__dirname}/../build/cache`

test('execute matches nargo', async (t) => {
  const { witness, returnValue } = await new Noir(circuit).execute(inputs)

  t.alike(Buffer.from(witness), nargoWitness)
  t.is(returnValue.length, 32)
  t.is(returnValue[0], '0xa3')
})

test('execute rejects inputs the circuit cannot solve', async (t) => {
  await t.exception(new Noir(circuit).execute({ x: '1000', y: '0' }))
})

test('proves and verifies with native barretenberg', async (t) => {
  const api = await createBarretenberg(Barretenberg, { dir })
  const backend = new UltraHonkBackend(circuit.bytecode, api)
  const { witness } = await new Noir(circuit).execute(inputs)

  const proof = await backend.generateProof(witness, { verifierTarget: 'evm' })

  t.ok(await backend.verifyProof(proof, { verifierTarget: 'evm' }))

  await api.destroy()
})

test('prefetch caches files that cachedFetch then serves from disk', async (t) => {
  const url = 'https://crs.aztec-cdn.foundation/g2.dat'

  await prefetch({ dir, crs: false, files: [url] })

  const response = await cachedFetch(dir, () => t.fail('went to the network'))(url)
  const g2 = require('bare-fs').readFileSync(`${dir}/bn254_g2.dat`)

  t.alike(Buffer.from(await response.arrayBuffer()), g2)
})

test('proves from the uncompressed witness with a precomputed verification key', async (t) => {
  const settings = { ipaAccumulation: false, oracleHashType: 'keccak', disableZk: false, optimizedSolidityVerifier: false }
  const api = await createBarretenberg(Barretenberg, { dir })
  const { acirUncompressedBytecode: bytecode } = new UltraHonkBackend(circuit.bytecode, api)
  const { bytes: verificationKey } = await api.circuitComputeVk({ circuit: { name: 'circuit', bytecode }, settings })
  const { uncompressedWitness } = await new Noir(circuit).execute(inputs)

  const { proof, publicInputs } = await api.circuitProve({
    witness: uncompressedWitness,
    circuit: { name: 'circuit', bytecode, verificationKey },
    settings
  })

  t.ok((await api.circuitVerify({ verificationKey, publicInputs, proof, settings })).verified)

  await api.destroy()
})

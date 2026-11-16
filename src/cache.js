const fs = require('bare-fs')
const path = require('bare-path')
const fetch = globalThis.fetch || require('bare-fetch')

// The CRS of bb.js 6.0.0: the hosts it downloads from and the files it caches, so that a
// directory filled here is also one bb.js can read, and the other way round.
const HOSTS = ['https://crs.aztec-cdn.foundation', 'https://crs.aztec-labs.com']

const G1_COMPRESSED = 'bn254_g1_compressed.dat' // 32 bytes per point
const G1 = 'bn254_g1.dat' // 64 bytes per point, written once barretenberg has decompressed
const G2 = 'bn254_g2.dat' // 128 bytes

// The SRS is one list of points, and a circuit of size 2^k uses its first 2^k. 2^18 covers every
// circuit of the Bermuda SDK, the largest (transact2x16, recover16x16) rounding up to 2^18 gates.
const SRS_SIZE = 2 ** 18

/**
 * Downloads what proving needs into `dir`, so that proving later reads it from disk only.
 * Whatever is cached already is kept, so this can run on every app start.
 *
 * - `crs`: `{ srsSize = 2 ** 18 }`, or `false` to skip the CRS.
 * - `files`: URLs to cache as well, such as circuit artifacts; `cachedFetch(dir)` serves them.
 */
async function prefetch({ dir, crs = {}, files = [] }) {
  await fs.promises.mkdir(path.join(dir, 'files'), { recursive: true })

  if (crs !== false) {
    const { srsSize = SRS_SIZE } = crs

    await download(dir, G1_COMPRESSED, 'g1_compressed.dat', srsSize * 32)
    await download(dir, G2, 'g2.dat', 128)
  }

  for (const url of files) {
    const file = cached(dir, url)
    if (await size(file)) continue

    const response = await fetch(url)
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)

    await writeAtomic(file, new Uint8Array(await response.arrayBuffer()))
  }
}

/** A `fetch()` that answers from `dir` for each URL `prefetch()` cached there, and otherwise fetches. */
function cachedFetch(dir, next = fetch) {
  return async function (url, init) {
    const file = cached(dir, String(url.url ?? url))

    if (await size(file)) {
      const body = await fs.promises.readFile(file)
      const arrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
      return { ok: true, status: 200, arrayBuffer: async () => arrayBuffer, json: async () => JSON.parse(body), text: async () => body.toString() }
    }

    return next(url, init)
  }
}

/** Loads the SRS cached in `dir` into barretenberg, keeping the points it decompresses for next time. */
async function loadSrs(api, { dir, srsSize = SRS_SIZE }) {
  const g2Point = await readPrefix(path.join(dir, G2), 128)
  const g1 = path.join(dir, G1)

  if ((await size(g1)) >= srsSize * 64) {
    await api.srsInitSrs({ pointsBuf: await readPrefix(g1, srsSize * 64), numPoints: srsSize, g2Point })
  } else {
    const pointsBuf = await readPrefix(path.join(dir, G1_COMPRESSED), srsSize * 32)
    const response = await api.srsInitSrs({ pointsBuf, numPoints: srsSize, g2Point })
    if (response.pointsBuf.length > 0) await writeAtomic(g1, response.pointsBuf)
  }
}

async function download(dir, name, remote, bytes) {
  const file = path.join(dir, name)
  if ((await size(file)) >= bytes) return

  let error
  for (const host of HOSTS) {
    try {
      const response = await fetch(`${host}/${remote}`, bytes > 128 ? { headers: { Range: `bytes=0-${bytes - 1}` } } : {})
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const data = new Uint8Array(await response.arrayBuffer())
      if (data.length < bytes) throw new Error(`${data.length} of ${bytes} bytes`)

      return await writeAtomic(file, data.subarray(0, bytes))
    } catch (err) {
      error = new Error(`${host}/${remote}: ${err.message}`)
    }
  }
  throw error
}

function cached(dir, url) {
  return path.join(dir, 'files', url.replace(/^[a-z]+:\/\//, '').replace(/[^A-Za-z0-9._-]/g, '_'))
}

async function size(file) {
  try {
    return (await fs.promises.stat(file)).size
  } catch {
    return 0
  }
}

async function readPrefix(file, bytes) {
  const handle = await fs.promises.open(file, 'r')
  try {
    const data = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(data, 0, bytes, 0)
    if (bytesRead < bytes) throw new Error(`${file} holds ${bytesRead} of the ${bytes} bytes needed; run prefetch() first`)
    return data
  } finally {
    await handle.close()
  }
}

async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`
  await fs.promises.writeFile(tmp, data)
  await fs.promises.rename(tmp, file)
}

module.exports = { prefetch, cachedFetch, loadSrs }

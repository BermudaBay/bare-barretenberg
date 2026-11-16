// Stands in for optional native Node.js modules that Bare has no build of, such as the two `ws`
// tries to load (and falls back from) for ethers and viem: loading it fails, as their absence would.
throw new Error('Not available in Bare')

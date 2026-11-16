// build/app.cjs is app.js with the SDK, bb.js and their dependencies, bundled into CommonJS by
// esbuild. The import map hands it this addon in place of @noir-lang/noir_js.
require('./build/app.cjs', { with: { imports: '@bermuda/bare-barretenberg/imports' } })

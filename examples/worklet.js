// The worklet both example apps run, in CommonJS: Bare's JavaScriptCore engine, which iOS apps use
// here, cannot load ES modules. Uncaught errors are reported to the app first; then Bare's Node.js
// compatibility layer is set up, and main.js loads the bundled app with this addon's import map.
require('./errors.js')
require('./globals.js')
require('./main.js', { with: { imports: 'bare-node-runtime/imports' } })

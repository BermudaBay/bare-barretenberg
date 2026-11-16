// Bare's Node.js globals, as bare-node-runtime/global sets them up, except Worker: bare-worker
// cannot load under JavaScriptCore, which has no SharedArrayBuffer, and nothing here starts workers.
require('bare-abort-controller/global')
require('bare-crypto/global')
require('bare-encoding/global')
require('bare-events/global')
require('bare-fetch/global')
require('bare-performance/global')
require('bare-process/global')
require('bare-stream/global')
require('bare-ws/global')

process.versions.node = '26.13.0'

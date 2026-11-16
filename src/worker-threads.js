// bb.js imports Worker, parentPort and threadId from worker_threads, none of which proving natively
// uses: it starts no workers. Bare's worker_threads (bare-worker) is only loaded once a Worker is
// constructed, as it cannot load without SharedArrayBuffer, which Bare's JavaScriptCore lacks.
exports.Worker = class Worker {
  constructor(...args) {
    return new (require('bare-worker').Worker)(...args)
  }
}

exports.parentPort = null
exports.workerData = null
exports.isMainThread = true
exports.threadId = 0

// Reports any error the worklet leaves uncaught to the app, as Bare Kit recommends: left alone, Bare
// would print it and abort the process, the app included.
const IPC = Bare.IPC ?? BareKit.IPC

function report(err) {
  IPC.write(JSON.stringify({ step: 'error', message: String(err?.stack ?? err) }) + '\n')
}

Bare.on('uncaughtException', report).on('unhandledRejection', report)

import BareKit
import SwiftUI

// Runs the example worklet (../app.js), in which the Bermuda SDK proves through
// @bermuda/bare-barretenberg, and shows what it reports.
@main
struct App: SwiftUI.App {
  @StateObject private var run = Run()

  var body: some Scene {
    WindowGroup {
      ScrollView {
        Text(run.log)
          .font(.system(.footnote, design: .monospaced))
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding()
      }
    }
  }
}

@MainActor
final class Run: ObservableObject {
  @Published var log = ""

  // Releasing a worklet terminates it, so it is kept for as long as the app runs.
  private var worklet: Worklet?

  init() {
    Task { await start() }
  }

  private func start() async {
    do {
      let worklet = try Worklet()
      let ipc = try IPC(worklet: worklet)
      self.worklet = worklet

      try worklet.start("app.bundle")

      // The worklet's first message is where it keeps the CRS: storage that outlives app updates.
      let dir = try FileManager.default.url(
        for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      try await ipc.write(Data(dir.path.utf8))

      for await data in ipc {
        let text = String(decoding: data, as: UTF8.self)
        log += text
        print(text, terminator: "")
      }
    } catch {
      log += "\(error)\n"
    }
  }
}

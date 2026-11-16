// swift-tools-version: 6.1
import PackageDescription

// Bare Kit with the system's JavaScriptCore in place of V8. V8 reserves 4 GiB of address space for
// its compressed pointers when a worklet starts, which iPhones with less memory only grant to apps
// signed with the Extended Virtual Addressing entitlement, which personal (free) teams cannot sign.
// JavaScriptCore needs no such reservation, and proving runs in native code either way.
let package = Package(
  name: "Engine",
  platforms: [.iOS(.v16)],
  products: [.library(name: "Engine", targets: ["Engine"])],
  dependencies: [
    .package(url: "https://github.com/holepunchto/bare-kit-swift", exact: "2.4.0", traits: ["JavaScriptCore"])
  ],
  targets: [
    .target(name: "Engine", dependencies: [.product(name: "BareKit", package: "bare-kit-swift")])
  ]
)

# Third-party notices

`@bermuda/bare-barretenberg` is licensed under BUSL-1.1 ([LICENSE](./LICENSE)). The parts below come
from third parties and remain under their own licenses.

## Prebuilt addons in `prebuilds/`

Each addon is built from this repository's sources and links statically:

- barretenberg's `libbb-external`, from the [aztec-packages](https://github.com/AztecProtocol/aztec-packages)
  v6.0.0 release, Apache-2.0;
- Noir's ACVM and ABI crates, from [noir-lang/noir](https://github.com/noir-lang/noir) v1.0.0, MIT OR
  Apache-2.0, and the other Rust crates pinned in `Cargo.lock`, each under the license its manifest
  names (mostly MIT, Apache-2.0 or both);
- on Android, LLVM's libc++, libc++abi and libunwind as zig 0.15.1 builds them, Apache-2.0 WITH
  LLVM-exception.

## `examples/vendor/`

`bermuda-sdk-0.3.7-arc-2f52e09c.tgz` is `@bermuda/sdk` at commit 2f52e09c, under its own license
(BUSL-1.1, in the archive).

The Apache License, Version 2.0 is available at <https://www.apache.org/licenses/LICENSE-2.0>.

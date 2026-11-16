cmake_minimum_required(VERSION 3.25)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)

project(bare_barretenberg C CXX)

bare_target(target)

# Per Bare target: the barretenberg static library of aztec-packages v6.0.0 (the release of
# bb.js 6.0.0, whose msgpack API it must match) with its SHA-256, and the Rust target triple.
if(target STREQUAL "ios-arm64")
  set(bb arm64-ios c7350fb21963da64d59d1b94835dfcdf71a78ea05752ed56af7004e5fa7f671d)
  set(rust aarch64-apple-ios)
elseif(target STREQUAL "ios-arm64-simulator")
  set(bb arm64-ios-sim 5ca108540b0cf88731cb6e6c3017eb630efbcfa3091c234971b78f0fb012f494)
  set(rust aarch64-apple-ios-sim)
elseif(target STREQUAL "android-arm64")
  set(bb arm64-android f861c899bc617807b3b55dddbf0e88cb80297e356831ca813f32b3c3115112d3)
  set(rust aarch64-linux-android)
elseif(target STREQUAL "android-x64")
  set(bb x86_64-android 85fba8c73d66206f1b2322a92fd854c98bfe9bc6b17b63e453d9532069516f76)
  set(rust x86_64-linux-android)
elseif(target STREQUAL "darwin-arm64")
  set(bb arm64-darwin 310b2baaee0f8c8a96725d9cc246ffd41243ed8606965ad0c87f99428288d964)
  set(rust aarch64-apple-darwin)
else()
  message(FATAL_ERROR "Unsupported target ${target}")
endif()

list(GET bb 0 bb_platform)
list(GET bb 1 bb_sha256)

set(bb_archive "${CMAKE_BINARY_DIR}/barretenberg-static-${bb_platform}.tar.gz")

file(
  DOWNLOAD "https://github.com/AztecProtocol/aztec-packages/releases/download/v6.0.0/barretenberg-static-${bb_platform}.tar.gz"
  "${bb_archive}"
  EXPECTED_HASH SHA256=${bb_sha256}
)

file(ARCHIVE_EXTRACT INPUT "${bb_archive}" DESTINATION "${CMAKE_BINARY_DIR}/bb")

set(witness "${CMAKE_CURRENT_SOURCE_DIR}/target/${rust}/release/libbare_barretenberg.a")

# The C a dependency compiles (blake3) has to target what this build targets.
string(REPLACE "-" "_" rust_env ${rust})

if(APPLE)
  set(cargo_env MACOSX_DEPLOYMENT_TARGET=${CMAKE_OSX_DEPLOYMENT_TARGET} IPHONEOS_DEPLOYMENT_TARGET=${CMAKE_OSX_DEPLOYMENT_TARGET})
elseif(ANDROID)
  set(cargo_env CC_${rust_env}=${CMAKE_C_COMPILER} "CFLAGS_${rust_env}=--target=${CMAKE_C_COMPILER_TARGET} --sysroot=${CMAKE_SYSROOT}" AR_${rust_env}=${CMAKE_AR})
endif()

add_custom_command(
  OUTPUT "${witness}"
  COMMAND ${CMAKE_COMMAND} -E env ${cargo_env} cargo build --release --locked --target ${rust} --manifest-path "${CMAKE_CURRENT_SOURCE_DIR}/Cargo.toml"
  DEPENDS src/witness.rs Cargo.toml Cargo.lock
  VERBATIM
)

add_custom_target(witness DEPENDS "${witness}")

add_bare_module(bare_barretenberg)

add_dependencies(${bare_barretenberg} witness)

target_sources(
  ${bare_barretenberg}
  PRIVATE
    src/binding.c
)

target_link_libraries(
  ${bare_barretenberg}
  PUBLIC
    "${witness}"
    "${CMAKE_BINARY_DIR}/bb/libbb-external.a"
)

if(APPLE)
  target_link_libraries(${bare_barretenberg} PUBLIC c++ "-framework CoreFoundation" "-Wl,-dead_strip")
elseif(ANDROID)
  # Aztec builds libbb-external with zig 0.15.1 against zig's libc++ (std::__1), which the NDK's
  # libc++ (std::__ndk1) cannot satisfy. Build zig's libc++ for the target, against the NDK's
  # bionic, and link it statically with its symbols hidden.
  find_program(zig NAMES zig REQUIRED)

  string(REGEX MATCH "^[^-]+" zig_arch "${CMAKE_C_COMPILER_TARGET}")

  set(zig_target ${zig_arch}-linux-android)
  set(zig_dir "${CMAKE_BINARY_DIR}/zig")
  set(sysroot "${CMAKE_SYSROOT}")

  file(
    WRITE "${zig_dir}/libc.txt"
    "include_dir=${sysroot}/usr/include\n"
    "sys_include_dir=${sysroot}/usr/include/${zig_target}\n"
    "crt_dir=${sysroot}/usr/lib/${zig_target}/${CMAKE_SYSTEM_VERSION}\n"
    "msvc_lib_dir=\nkernel32_lib_dir=\ngcc_dir=\n"
  )

  file(WRITE "${zig_dir}/libcxx.cpp" "")

  execute_process(
    COMMAND "${zig}" build-lib -dynamic -O ReleaseFast -target ${zig_target} -lc -lc++ --libc libc.txt libcxx.cpp --verbose-link
    WORKING_DIRECTORY "${zig_dir}"
    ERROR_VARIABLE zig_link
    COMMAND_ERROR_IS_FATAL ANY
  )

  string(REGEX MATCHALL "[^ \n]+/lib(c\\+\\+abi|c\\+\\+|unwind)\\.a" libcxx "${zig_link}")

  list(REMOVE_DUPLICATES libcxx)

  target_link_libraries(${bare_barretenberg} PUBLIC ${libcxx} log "-Wl,--exclude-libs,ALL" "-Wl,--gc-sections")
endif()

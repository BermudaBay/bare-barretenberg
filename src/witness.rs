//! Native Noir witness generation: a byte-for-byte replacement for noir_js 1.0.0 `Noir.execute`.
//!
//! noir_js runs `abiEncode` (noirc_abi wasm), then `executeProgram` (acvm_js) with its default
//! foreign call handler, then `abiDecode` and `compressWitnessStack`. This file mirrors those steps
//! with the same noir v1.0.0 crates, so the witness bytes, the return value JSON and the error
//! messages come out as noir_js produces them.

use std::collections::BTreeMap;
use std::io::Read;
use std::panic::{AssertUnwindSafe, catch_unwind};

use acvm::acir::SerializationFormat;
use acvm::acir::brillig::ForeignCallResult;
use acvm::acir::circuit::{Circuit, Program};
use acvm::acir::native_types::{WitnessMap, WitnessStack};
use acvm::pwg::{
    ACVM, ACVMStatus, ForeignCallWaitInfo, OpcodeResolutionError, RawAssertionPayload,
    ResolvedAssertionPayload,
};
use acvm::{AcirField, FieldElement};
use bn254_blackbox_solver::Bn254BlackBoxSolver;
use flate2::Compression;
use flate2::bufread::GzEncoder;
use noirc_abi::errors::InputParserError;
use noirc_abi::input_parser::{InputValue, json::JsonTypes};
use noirc_abi::{Abi, AbiErrorType, decode_value, display_abi_error};
use serde::Serialize;

type F = FieldElement;

/// Witness maps in the order acvm_js pushes them: each ACIR call as it returns, `main` last.
type Stack = Vec<(u32, WitnessMap<F>)>;

/// A failure of `executeProgram`, kept apart by the JS error kind because noir_js words them differently.
enum ExecError {
    /// acvm_js `ExecutionError`: noir_js keeps the message, unless the raw assertion payload decodes to a string.
    Acvm { message: String, payload: Option<RawAssertionPayload<F>> },
    /// A plain JS `Error` (a rejected foreign call): noir_js throws `Circuit execution failed: ${err}`.
    Js(String),
}

/// Runs noir_js `Noir.execute` and returns the witness stack, uncompressed, and the return value JSON.
fn execute(bytecode: &[u8], abi_json: &[u8], inputs_json: &[u8]) -> Result<(Vec<u8>, String), String> {
    let abi: Abi = serde_json::from_slice(abi_json).map_err(|err| err.to_string())?;
    let initial_witness = abi_encode(&abi, inputs_json)?;

    let stack = execute_program(bytecode, initial_witness).map_err(|err| error_message(&abi, err))?;

    // noir_js decodes `witness_stack[0]`, which is `main` only for single-function programs; kept as is.
    let return_value = abi_decode_return_value(&abi, &stack[0].1)?;

    let mut witness_stack = WitnessStack::default();
    for (index, witness) in stack {
        witness_stack.push(index, witness);
    }
    Ok((serialize(&witness_stack)?, return_value))
}

/// The witness stack as barretenberg reads it: acvm's `serialize_with_format` in the default
/// format (acvm_js reads the format from an env var that never exists in wasm), which writes the
/// format byte and then msgpack with structs as tuples, but without the gzip acvm wraps it in.
/// acvm keeps that serialization private, so it is spelled out here, as acvm does it.
fn serialize(stack: &WitnessStack<F>) -> Result<Vec<u8>, String> {
    let mut buf = vec![u8::from(SerializationFormat::MsgpackCompact)];
    let mut serializer = rmp_serde::Serializer::new(&mut buf)
        .with_bytes(rmp_serde::config::BytesMode::ForceIterables)
        .with_struct_tuple();
    Serialize::serialize(stack, &mut serializer).map_err(|err| err.to_string())?;
    Ok(buf)
}

/// Gzips as acvm gzips a serialized witness stack (`bufread::GzEncoder`, best compression), so a
/// witness from `execute` comes out as noir_js's `compressWitnessStack` bytes.
fn gzip(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    GzEncoder::new(input, Compression::best())
        .read_to_end(&mut buf)
        .map_err(|err| err.to_string())?;
    Ok(buf)
}

/// noirc_abi wasm `abiEncode(abi, inputs)`; `inputs_json` is `JSON.stringify(inputs)`, as the wasm sees it.
fn abi_encode(abi: &Abi, inputs_json: &[u8]) -> Result<WitnessMap<F>, String> {
    let inputs: BTreeMap<String, JsonTypes> =
        serde_json::from_slice(inputs_json).map_err(|err| err.to_string())?;
    for value in inputs.values() {
        reject_unsafe_integers(value)?;
    }

    let mut parsed = BTreeMap::new();
    for (name, typ) in abi.to_btree_map() {
        let value = inputs
            .get(&name)
            .ok_or_else(|| InputParserError::MissingArgument(name.clone()).to_string())?;
        let value =
            InputValue::try_from_json(value.clone(), &typ, &name).map_err(|err| err.to_string())?;
        parsed.insert(name, value);
    }

    abi.encode(&parsed, None).map_err(|err| err.to_string())
}

/// A JS number above 2^53 - 1 may already be rounded, so the wasm encoder refuses it.
fn reject_unsafe_integers(value: &JsonTypes) -> Result<(), String> {
    const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
    match value {
        JsonTypes::Integer(integer) if integer.unsigned_abs() > MAX_SAFE_INTEGER => Err(format!(
            "Numeric input `{integer}` is not a safe integer (its magnitude exceeds 2^53 - 1, so \
             JavaScript may have already rounded it); pass it as a string instead"
        )),
        JsonTypes::Array(items) => items.iter().try_for_each(reject_unsafe_integers),
        JsonTypes::Table(map) => map.values().try_for_each(reject_unsafe_integers),
        _ => Ok(()),
    }
}

/// acvm_js `executeProgram` with noir_js's default foreign call handler.
fn execute_program(bytecode: &[u8], initial_witness: WitnessMap<F>) -> Result<Stack, ExecError> {
    let program: Program<F> = Program::deserialize_program(bytecode).map_err(|_| ExecError::Acvm {
        message: "Failed to deserialize circuit. This is likely due to differing serialization \
                  formats between ACVM_JS and your compiler"
            .to_string(),
        payload: None,
    })?;

    let mut stack = Stack::new();
    let main = execute_circuit(&program, &program.functions[0], initial_witness, &mut stack)?;
    stack.push((0, main));
    Ok(stack)
}

/// Solves one ACIR function, recursing into the ACIR functions it calls.
fn execute_circuit(
    program: &Program<F>,
    circuit: &Circuit<F>,
    initial_witness: WitnessMap<F>,
    stack: &mut Stack,
) -> Result<WitnessMap<F>, ExecError> {
    let mut acvm = ACVM::new(
        &Bn254BlackBoxSolver,
        &circuit.opcodes,
        initial_witness,
        &program.unconstrained_functions,
        &circuit.assert_messages,
    );

    loop {
        match acvm.solve() {
            ACVMStatus::Solved => return Ok(acvm.finalize()),
            ACVMStatus::InProgress => {
                unreachable!("Execution should not stop while in `InProgress` state.")
            }
            ACVMStatus::Failure(error) => return Err(acvm_failure(error)),
            ACVMStatus::RequiresForeignCall(call) => {
                acvm.resolve_pending_foreign_call(foreign_call(&call).map_err(ExecError::Js)?);
            }
            ACVMStatus::RequiresAcirCall(call) => {
                let callee = &program.functions[call.id.as_usize()];
                let solved = execute_circuit(program, callee, call.initial_witness, stack)?;
                let mut outputs = Vec::new();
                for index in callee.return_values.indices() {
                    let Some(value) = solved.get_index(index) else {
                        return Err(ExecError::Acvm {
                            message: format!(
                                "Failed to read from solved witness of ACIR call at witness {index}"
                            ),
                            payload: None,
                        });
                    };
                    outputs.push(*value);
                }
                acvm.resolve_pending_acir_call(outputs);
                stack.push((call.id.as_u32(), solved));
            }
        }
    }
}

/// noir_js's default handler: `print` gets an empty answer, any other oracle rejects.
fn foreign_call(call: &ForeignCallWaitInfo<F>) -> Result<ForeignCallResult<F>, String> {
    if call.function == "print" {
        return Ok(ForeignCallResult::default());
    }
    // `${args.join(', ')}` over arrays of hex strings: params joined by ", ", fields within one by ",".
    let args: Vec<String> = call
        .inputs
        .iter()
        .map(|param| {
            let fields: Vec<String> =
                param.fields().iter().map(|field| format!("0x{}", field.to_hex())).collect();
            fields.join(",")
        })
        .collect();
    // acvm_js reports only "Error awaiting `foreign_call_handler`" and keeps the handler's error as
    // its `cause`; the cause is appended here since this ABI has no side channel for it.
    Err(format!(
        "Error awaiting `foreign_call_handler`: Unexpected oracle during execution: {}({})",
        call.function,
        args.join(", ")
    ))
}

/// acvm_js's `ExecutionError` message: assertion payloads that are static strings are inlined.
fn acvm_failure(error: OpcodeResolutionError<F>) -> ExecError {
    let (message, payload) = match error {
        OpcodeResolutionError::UnsatisfiedConstrain { payload: Some(payload), .. }
        | OpcodeResolutionError::BrilligFunctionFailed { payload: Some(payload), .. } => {
            match payload {
                ResolvedAssertionPayload::Raw(raw) => ("Assertion failed".to_string(), Some(raw)),
                ResolvedAssertionPayload::String(message) => {
                    (format!("Assertion failed: {message}"), None)
                }
            }
        }
        error => (error.to_string(), None),
    };
    ExecError::Acvm { message, payload }
}

/// noir_js `generateWitness` error wording, including its `enrichExecutionError` payload decoding.
fn error_message(abi: &Abi, error: ExecError) -> String {
    match error {
        ExecError::Js(message) => format!("Circuit execution failed: Error: {message}"),
        ExecError::Acvm { message, payload: None } => message,
        ExecError::Acvm { message, payload: Some(raw) } => match abi_decode_error(abi, raw) {
            Some(Ok(string)) => format!("Circuit execution failed: {string}"),
            // noir_js attaches a non-string payload as `decodedAssertionPayload`; appended here instead.
            Some(Err(json)) => format!("{message}: {json}"),
            None => message,
        },
    }
}

/// noirc_abi wasm `abiDecodeError`: Ok for a JS string result, Err(JSON) otherwise. None where
/// noir_js swallows the decoding failure (including the wasm panicking).
fn abi_decode_error(abi: &Abi, raw: RawAssertionPayload<F>) -> Option<Result<String, String>> {
    let error_type = abi.error_types.get(&raw.selector)?;
    catch_unwind(AssertUnwindSafe(|| match error_type {
        AbiErrorType::FmtString { .. } => {
            Some(Ok(display_abi_error(&raw.data, error_type.clone()).to_string()))
        }
        AbiErrorType::Custom(typ) => {
            let value = decode_value(&mut raw.data.iter().copied(), typ, "error").ok()?;
            match JsonTypes::try_from_input_value(&value, typ).ok()? {
                JsonTypes::String(string) => Some(Ok(string)),
                json => serde_json::to_string(&json).ok().map(Err),
            }
        }
        AbiErrorType::String { string } => Some(Ok(string.clone())),
    }))
    .ok()
    .flatten()
}

/// `JSON.stringify(abiDecode(abi, witness).return_value)`. The wasm hands serde_json output to
/// `JSON.parse`; re-stringifying that gives the same text back (no numbers, sorted non-index keys).
fn abi_decode_return_value(abi: &Abi, witness: &WitnessMap<F>) -> Result<String, String> {
    // Decoding validates every input as well, so its errors surface here as they do in noir_js.
    let (_, return_value) = abi.decode(witness).map_err(|err| err.to_string())?;
    let json = match (return_value, &abi.return_type) {
        (Some(value), Some(return_type)) => Some(
            JsonTypes::try_from_input_value(&value, &return_type.abi_type)
                .map_err(|err| err.to_string())?,
        ),
        _ => None,
    };
    serde_json::to_string(&json).map_err(|err| err.to_string())
}

/// Borrows a C buffer; a zero length needs no valid pointer.
///
/// # Safety
/// For a nonzero `len`, `ptr` must be valid for `len` bytes for the duration of the call.
unsafe fn borrow<'a>(ptr: *const u8, len: usize) -> Result<&'a [u8], String> {
    match (len, ptr.is_null()) {
        (0, _) => Ok(&[]),
        (_, true) => Err("null pointer with a nonzero length".to_string()),
        _ => Ok(unsafe { std::slice::from_raw_parts(ptr, len) }),
    }
}

/// Executes a compiled Noir program on ABI inputs, as noir_js's `Noir.execute` does.
///
/// On success returns 0 and sets `*out` to: u32 little-endian witness length, the witness stack
/// uncompressed (`bare_barretenberg_gzip` turns it into acvm_js `compressWitnessStack`'s bytes),
/// then the return value as UTF-8 JSON ("null" if none). On failure returns 1 and sets `*out` to a
/// UTF-8 error message. Release `*out` with `bare_barretenberg_free`. Returns -1, writing nothing,
/// if `out` or `out_len` is null.
///
/// # Safety
/// Each input pointer must be valid for its length (or the length 0); `out` and `out_len` must be
/// writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bare_barretenberg_execute(
    bytecode: *const u8,
    bytecode_len: usize,
    abi_json: *const u8,
    abi_len: usize,
    inputs_json: *const u8,
    inputs_len: usize,
    out: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    if out.is_null() || out_len.is_null() {
        return -1;
    }

    respond(
        catch_unwind(AssertUnwindSafe(|| {
            let (witness, return_value) = unsafe {
                execute(
                    borrow(bytecode, bytecode_len)?,
                    borrow(abi_json, abi_len)?,
                    borrow(inputs_json, inputs_len)?,
                )?
            };
            let witness_len = u32::try_from(witness.len()).map_err(|err| err.to_string())?;
            let mut buf = Vec::with_capacity(4 + witness.len() + return_value.len());
            buf.extend_from_slice(&witness_len.to_le_bytes());
            buf.extend_from_slice(&witness);
            buf.extend_from_slice(return_value.as_bytes());
            Ok(buf)
        })),
        out,
        out_len,
    )
}

/// Gzips a witness stack from `bare_barretenberg_execute` into noir_js's bytes for it. Returns and
/// sets `*out` as `bare_barretenberg_execute` does.
///
/// # Safety
/// As for `bare_barretenberg_execute`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bare_barretenberg_gzip(
    input: *const u8,
    input_len: usize,
    out: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    if out.is_null() || out_len.is_null() {
        return -1;
    }

    respond(catch_unwind(AssertUnwindSafe(|| gzip(unsafe { borrow(input, input_len)? }))), out, out_len)
}

/// Hands a result to C: 0 and the bytes, or 1 and the error message (a panic's included).
fn respond(result: std::thread::Result<Result<Vec<u8>, String>>, out: *mut *mut u8, out_len: *mut usize) -> i32 {
    let result = result.unwrap_or_else(|panic| {
        let reason = panic
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| panic.downcast_ref::<String>().cloned())
            .unwrap_or_default();
        Err(format!("panic: {reason}"))
    });

    let (code, buf) = match result {
        Ok(buf) => (0, buf),
        Err(message) => (1, message.into_bytes()),
    };
    let buf = buf.into_boxed_slice();
    unsafe {
        *out_len = buf.len();
        *out = Box::into_raw(buf).cast::<u8>();
    }
    code
}

/// Frees a buffer returned through the `out` of `bare_barretenberg_execute` or `bare_barretenberg_gzip`.
///
/// # Safety
/// `ptr` and `len` must be exactly what one of those returned, freed once; null is a no-op.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bare_barretenberg_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });
    }
}

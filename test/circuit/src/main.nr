// Small, but it touches every part of witness generation: ABI inputs, an unconstrained
// (Brillig) call, range checks, a hash black box and a public return value.
fn main(x: u32, y: pub u32) -> pub [u8; 32] {
    // Safety: the quotient is checked right below.
    let q = unsafe { div(x, y) };
    assert(q * y + x % y == x);
    let bytes: [u8; 4] = (x as Field).to_le_bytes();
    std::hash::blake3(bytes)
}

unconstrained fn div(a: u32, b: u32) -> u32 {
    a / b
}

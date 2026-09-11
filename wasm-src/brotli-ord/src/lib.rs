//! ord's brotli encoder, compiled to wasm.
//!
//! `compress` runs the same code ord runs for `wallet inscribe --compress`
//! (cat21-ord src/inscriptions/inscription.rs, `Inscription::compress`): a
//! `CompressorWriter` with buffer size = input length and quality 11,
//! lgwin 24, lgblock 24, size_hint = input length, and the caller's mode.
//! Same crate, same version, same parameters, same call sequence, so the
//! output bytes are ord's bytes.
//!
//! Plain C ABI, no wasm-bindgen: the host allocates an input buffer with
//! `alloc`, calls `compress`, reads `result_len` bytes at `result_ptr`, then
//! calls `result_free` and `dealloc`.

mod glibc_log2f;

use std::io::Write;

use brotli::enc::backward_references::BrotliEncoderMode;
use brotli::enc::BrotliEncoderParams;
use brotli::CompressorWriter;

static mut RESULT: Vec<u8> = Vec::new();

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
  let mut buf = Vec::<u8>::with_capacity(len);
  let ptr = buf.as_mut_ptr();
  std::mem::forget(buf);
  ptr
}

/// # Safety
/// `ptr` and `len` must come from a matching `alloc` call.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
  drop(Vec::from_raw_parts(ptr, 0, len));
}

/// Compress `len` bytes at `ptr`. `mode`: 0 generic, 1 text, 2 font (the
/// `BrotliEncoderMode` discriminants). Returns the compressed length; the
/// bytes are at `result_ptr()` until the next `compress` or `result_free`.
/// Returns -1 for an unknown mode or a write error.
///
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn compress(ptr: *const u8, len: usize, mode: u32) -> i32 {
  let mode = match mode {
    0 => BrotliEncoderMode::BROTLI_MODE_GENERIC,
    1 => BrotliEncoderMode::BROTLI_MODE_TEXT,
    2 => BrotliEncoderMode::BROTLI_MODE_FONT,
    _ => return -1,
  };
  let data = std::slice::from_raw_parts(ptr, len);

  let mut compressor = CompressorWriter::with_params(
    Vec::new(),
    data.len(),
    &BrotliEncoderParams {
      lgblock: 24,
      lgwin: 24,
      mode,
      quality: 11,
      size_hint: data.len(),
      ..Default::default()
    },
  );
  if compressor.write_all(data).is_err() {
    return -1;
  }
  let out = compressor.into_inner();
  let n = out.len() as i32;
  RESULT = out;
  n
}

#[no_mangle]
pub unsafe extern "C" fn result_ptr() -> *const u8 {
  #[allow(static_mut_refs)]
  RESULT.as_ptr()
}

/// `(v as f32).log2()` as brotli computes it, exported so a test can check
/// the linked `log2f` against glibc.
#[no_mangle]
pub extern "C" fn probe_log2(v: u32) -> u32 {
  (v as f32).log2().to_bits()
}

#[no_mangle]
pub unsafe extern "C" fn result_free() {
  RESULT = Vec::new();
}

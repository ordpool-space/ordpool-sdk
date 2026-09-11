//! `log2f` as glibc computes it, for the wasm build.
//!
//! brotli's encoder takes `(v as f32).log2()` of histogram counts of 256 and
//! up (brotli 8.0.2 src/enc/util.rs, `FastLog2` and `FastLog2f64`) and its
//! block-splitting and cost decisions depend on the result. ord runs on
//! glibc, whose `log2f` is not correctly rounded (0.752 ULP), and the libm
//! wasm32 ships with rounds differently on some inputs, which changes the
//! compressed bytes of larger bodies. Exporting this symbol makes the wasm
//! link glibc's algorithm instead.
//!
//! Port of glibc 2.36 sysdeps/ieee754/flt-32/e_log2f.c and e_log2f_data.c
//! (the ARM optimized-routines log2f). Checked bit for bit against glibc
//! 2.36 for every integer from 256 to 2^24.

/// (invc, logc) per subinterval, `__log2f_data.tab`. Bit patterns of the
/// hex-float literals in the trailing comments.
const TAB: [(f64, f64); 16] = [
  (f64::from_bits(0x3ff661ec79f8f3be), f64::from_bits(0xbfdefec65b963019)), // 0x1.661ec79f8f3bep+0, -0x1.efec65b963019p-2
  (f64::from_bits(0x3ff571ed4aaf883d), f64::from_bits(0xbfdb0b6832d4fca4)), // 0x1.571ed4aaf883dp+0, -0x1.b0b6832d4fca4p-2
  (f64::from_bits(0x3ff49539f0f010b0), f64::from_bits(0xbfd7418b0a1fb77b)), // 0x1.49539f0f010bp+0, -0x1.7418b0a1fb77bp-2
  (f64::from_bits(0x3ff3c995b0b80385), f64::from_bits(0xbfd39de91a6dcf7b)), // 0x1.3c995b0b80385p+0, -0x1.39de91a6dcf7bp-2
  (f64::from_bits(0x3ff30d190c8864a5), f64::from_bits(0xbfd01d9bf3f2b631)), // 0x1.30d190c8864a5p+0, -0x1.01d9bf3f2b631p-2
  (f64::from_bits(0x3ff25e227b0b8ea0), f64::from_bits(0xbfc97c1d1b3b7af0)), // 0x1.25e227b0b8eap+0, -0x1.97c1d1b3b7afp-3
  (f64::from_bits(0x3ff1bb4a4a1a343f), f64::from_bits(0xbfc2f9e393af3c9f)), // 0x1.1bb4a4a1a343fp+0, -0x1.2f9e393af3c9fp-3
  (f64::from_bits(0x3ff12358f08ae5ba), f64::from_bits(0xbfb960cbbf788d5c)), // 0x1.12358f08ae5bap+0, -0x1.960cbbf788d5cp-4
  (f64::from_bits(0x3ff0953f419900a7), f64::from_bits(0xbfaa6f9db6475fce)), // 0x1.0953f419900a7p+0, -0x1.a6f9db6475fcep-5
  (f64::from_bits(0x3ff0000000000000), f64::from_bits(0x0000000000000000)), // 0x1p+0, 0x0p+0
  (f64::from_bits(0x3fee608cfd9a47ac), f64::from_bits(0x3fb338ca9f24f53d)), // 0x1.e608cfd9a47acp-1, 0x1.338ca9f24f53dp-4
  (f64::from_bits(0x3feca4b31f026aa0), f64::from_bits(0x3fc476a9543891ba)), // 0x1.ca4b31f026aap-1, 0x1.476a9543891bap-3
  (f64::from_bits(0x3feb2036576afce6), f64::from_bits(0x3fce840b4ac4e4d2)), // 0x1.b2036576afce6p-1, 0x1.e840b4ac4e4d2p-3
  (f64::from_bits(0x3fe9c2d163a1aa2d), f64::from_bits(0x3fd40645f0c6651c)), // 0x1.9c2d163a1aa2dp-1, 0x1.40645f0c6651cp-2
  (f64::from_bits(0x3fe886e6037841ed), f64::from_bits(0x3fd88e9c2c1b9ff8)), // 0x1.886e6037841edp-1, 0x1.88e9c2c1b9ff8p-2
  (f64::from_bits(0x3fe767dcf5534862), f64::from_bits(0x3fdce0a44eb17bcc)), // 0x1.767dcf5534862p-1, 0x1.ce0a44eb17bccp-2
];

/// `__log2f_data.poly`.
const A: [f64; 4] = [
  f64::from_bits(0xbfd712b6f70a7e4d), // -0x1.712b6f70a7e4dp-2
  f64::from_bits(0x3fdecabf496832e0), // 0x1.ecabf496832ep-2
  f64::from_bits(0xbfe715479ffae3de), // -0x1.715479ffae3dep-1
  f64::from_bits(0x3ff715475f35c8b8), // 0x1.715475f35c8b8p0
];

/// `OFF` in e_log2f.c: the subinterval split point.
const OFF: u32 = 0x3f330000;

#[no_mangle]
pub extern "C" fn log2f(x: f32) -> f32 {
  let mut ix = x.to_bits();
  // log2(1) is exactly +0.
  if ix == 0x3f800000 {
    return 0.0;
  }
  if ix.wrapping_sub(0x00800000) >= 0x7f800000 - 0x00800000 {
    // x < 0x1p-126, or inf, or nan.
    if ix.wrapping_mul(2) == 0 {
      return f32::NEG_INFINITY;
    }
    if ix == 0x7f800000 {
      return x;
    }
    if (ix & 0x80000000) != 0 || ix.wrapping_mul(2) >= 0xff000000 {
      return f32::NAN;
    }
    // Subnormal: scale by 2^23 and take it back out of the exponent.
    ix = (x * f32::from_bits(0x4b000000)).to_bits();
    ix = ix.wrapping_sub(23 << 23);
  }

  // x = 2^k z, z in [OFF, 2*OFF] and exact; 16 subintervals, c near the
  // centre of the one holding z.
  let tmp = ix.wrapping_sub(OFF);
  let i = ((tmp >> (23 - 4)) % 16) as usize;
  let top = tmp & 0xff800000;
  let iz = ix.wrapping_sub(top);
  let k = (tmp as i32) >> 23; // arithmetic shift
  let (invc, logc) = TAB[i];
  let z = f32::from_bits(iz) as f64;

  // log2(x) = log1p(z/c - 1)/ln2 + log2(c) + k
  let r = z * invc - 1.0;
  let y0 = logc + k as f64;
  let r2 = r * r;
  let mut y = A[1] * r + A[2];
  y = A[0] * r2 + y;
  let p = A[3] * r + y0;
  y = y * r2 + p;
  y as f32
}

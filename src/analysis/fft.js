// Minimal in-place iterative radix-2 Cooley–Tukey FFT.
// `re` and `im` are Float32/Float64 arrays of length N (a power of two).
// Transforms in place. Good enough for offline chroma extraction.

export function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;

  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wReal = Math.cos(ang), wImag = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curReal = 1, curImag = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tReal = re[b] * curReal - im[b] * curImag;
        const tImag = re[b] * curImag + im[b] * curReal;
        re[b] = re[a] - tReal;
        im[b] = im[a] - tImag;
        re[a] += tReal;
        im[a] += tImag;
        const nextReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
      }
    }
  }
}

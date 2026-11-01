// Speech to a small audio file: Opus (the browser's own WebCodecs encoder) in an Ogg file that any <audio> element
// plays. An hour of the natural voice is about 16 MB this way, against 300 MB as plain samples, so prepared chapters
// can be kept on the device. Works in the page and in workers.

export const opusSupported = () => typeof AudioEncoder !== 'undefined';
const RATE = 48000;     // Opus always runs at 48 kHz
const BITRATE = 40000;  // clean speech, mono

// CRC-32 as Ogg uses it (polynomial 0x04c11db7, no reflection)
const CRC = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; CRC[i] = r >>> 0; }
const crc32 = (b) => { let c = 0; for (let i = 0; i < b.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ b[i]) & 255]) >>> 0; return c; };

// One Ogg page holding whole packets.
function page(packets, granule, seq, flags) {
  const lacing = [];
  for (const p of packets) { let n = p.length; while (n >= 255) { lacing.push(255); n -= 255; } lacing.push(n); }
  const size = 27 + lacing.length + packets.reduce((n, p) => n + p.length, 0), b = new Uint8Array(size), v = new DataView(b.buffer);
  b.set([79, 103, 103, 83]); v.setUint8(5, flags);
  v.setBigInt64(6, BigInt(granule), true); v.setUint32(14, 0x4c495054, true); v.setUint32(18, seq, true);
  v.setUint8(26, lacing.length); b.set(lacing, 27);
  let o = 27 + lacing.length;
  for (const p of packets) { b.set(p, o); o += p.length; }
  v.setUint32(22, crc32(b), true);
  return b;
}
function head(preSkip, inputRate) {
  const b = new Uint8Array(19), v = new DataView(b.buffer);
  b.set([...'OpusHead'].map(c => c.charCodeAt(0))); v.setUint8(8, 1); v.setUint8(9, 1);
  v.setUint16(10, preSkip, true); v.setUint32(12, inputRate, true);
  return b;
}
function tags() {
  const vendor = [...'Lipat'].map(c => c.charCodeAt(0)), b = new Uint8Array(8 + 4 + vendor.length + 4), v = new DataView(b.buffer);
  b.set([...'OpusTags'].map(c => c.charCodeAt(0))); v.setUint32(8, vendor.length, true); b.set(vendor, 12);
  return b;
}
// to 48 kHz, cubic interpolation: speech from 24 or 44.1 kHz only goes up, so nothing folds back
function resample(x, from) {
  if (from === RATE) return x;
  const n = Math.floor(x.length * RATE / from), out = new Float32Array(n), step = from / RATE, at = (i) => x[Math.min(x.length - 1, Math.max(0, i))];
  for (let i = 0; i < n; i++) {
    const p = i * step, k = Math.floor(p), t = p - k, a = at(k - 1), b = at(k), c = at(k + 1), d = at(k + 2);
    out[i] = b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
  }
  return out;
}

// Float32 samples to the bytes of an Ogg Opus file.
export async function encodeOgg(samples, sampleRate) {
  const pcm = resample(samples, sampleRate), packets = [];
  let preSkip = 312, failed = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); packets.push(b);
      const d = meta?.decoderConfig?.description;
      if (d && d.byteLength >= 12) preSkip = new DataView(d instanceof ArrayBuffer ? d : d.buffer, d.byteOffset || 0).getUint16(10, true);
    },
    error: (e) => { failed = e; },
  });
  enc.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate: BITRATE });
  const frame = RATE / 50; // 20 ms
  for (let o = 0; o < pcm.length; o += frame * 50) {
    const part = pcm.subarray(o, Math.min(pcm.length, o + frame * 50));
    const data = new AudioData({ format: 'f32', sampleRate: RATE, numberOfFrames: part.length, numberOfChannels: 1, timestamp: Math.round(o / RATE * 1e6), data: part.slice() });
    enc.encode(data); data.close();
  }
  await enc.flush(); enc.close();
  if (failed) throw failed;
  // pages of up to 50 packets; the last page's granule cuts the encoder's padding off
  const pages = [page([head(preSkip, sampleRate)], 0, 0, 2), page([tags()], 0, 1, 0)];
  const per = frame, total = preSkip + pcm.length;
  for (let i = 0, seq = 2; i < packets.length; i += 50, seq++) {
    const last = i + 50 >= packets.length, end = last ? total : Math.min(total, preSkip + (i + 50) * per);
    pages.push(page(packets.slice(i, i + 50), end, seq, last ? 4 : 0));
  }
  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of pages) { out.set(p, o); o += p.length; }
  return out;
}

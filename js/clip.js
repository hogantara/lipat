// One sentence of speech as it is kept on the device: Opus through WebCodecs where the browser has it (about 4 KB a
// second at 32 kbit/s), else 16-bit PCM (about 48 KB a second at 24 kHz). The speech workers encode, the page decodes
// to a WAV for its <audio> element.
//
// clip: { codec: 'opus', rate, frames, chunks: [Uint8Array], durs: [µs], desc } or { codec: 'pcm', rate, frames, pcm }

const OPUS_RATES = new Set([8000, 12000, 16000, 24000, 48000]);
const BITRATE = 32000;

// Opus takes only its own rates: anything else (Supertonic's 44.1 kHz) goes up to 48 kHz first.
function resample(wav, from, to) {
  const n = Math.floor(wav.length * to / from), out = new Float32Array(n), step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step, j = Math.floor(x), f = x - j;
    out[i] = (wav[j] || 0) * (1 - f) + (wav[j + 1] ?? wav[j] ?? 0) * f;
  }
  return out;
}

function pcmClip(wav, rate) {
  const pcm = new Int16Array(wav.length);
  for (let i = 0; i < wav.length; i++) pcm[i] = Math.max(-1, Math.min(1, wav[i])) * 32767;
  return { codec: 'pcm', rate, frames: wav.length, pcm };
}

// wav: Float32Array of samples at rate. Resolves to a clip, or null for no sound.
export async function encodeClip(wav, rate) {
  if (!wav || !wav.length) return null;
  if (typeof AudioEncoder === 'undefined') return pcmClip(wav, rate);
  try {
    const r = OPUS_RATES.has(rate) ? rate : 48000, data = r === rate ? wav : resample(wav, rate, r);
    const chunks = [], durs = [];
    let desc = null, failed = null;
    const enc = new AudioEncoder({
      output: (c, meta) => {
        const d = new Uint8Array(c.byteLength); c.copyTo(d); chunks.push(d); durs.push(c.duration || 0);
        const ds = meta?.decoderConfig?.description;
        if (ds) desc = ArrayBuffer.isView(ds) ? new Uint8Array(ds.buffer, ds.byteOffset, ds.byteLength).slice() : new Uint8Array(ds.slice(0));
      },
      error: (e) => { failed = e; },
    });
    enc.configure({ codec: 'opus', sampleRate: r, numberOfChannels: 1, bitrate: BITRATE });
    const audio = new AudioData({ format: 'f32', sampleRate: r, numberOfFrames: data.length, numberOfChannels: 1, timestamp: 0, data });
    enc.encode(audio); audio.close();
    await enc.flush(); enc.close();
    if (failed || !chunks.length) throw failed || new Error('no output');
    return { codec: 'opus', rate: r, frames: data.length, chunks, durs, desc };
  } catch { return pcmClip(wav, rate); }
}

// Resolves to { pcm: Int16Array, rate }.
export async function decodeClip(clip) {
  if (clip.codec === 'pcm') return { pcm: clip.pcm, rate: clip.rate };
  const parts = [];
  let failed = null;
  const dec = new AudioDecoder({
    output: (a) => { const f = new Float32Array(a.numberOfFrames); a.copyTo(f, { planeIndex: 0, format: 'f32-planar' }); parts.push(f); a.close(); },
    error: (e) => { failed = e; },
  });
  dec.configure({ codec: 'opus', sampleRate: clip.rate, numberOfChannels: 1, ...(clip.desc ? { description: clip.desc } : {}) });
  let t = 0;
  clip.chunks.forEach((d, i) => { dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: t, duration: clip.durs[i] || undefined, data: d })); t += clip.durs[i] || 0; });
  await dec.flush(); dec.close();
  if (failed) throw failed;
  // the codec pads the last frame: keep the sentence's own length
  const pcm = new Int16Array(clip.frames);
  let o = 0;
  for (const f of parts) for (let i = 0; i < f.length && o < pcm.length; i++) pcm[o++] = Math.max(-1, Math.min(1, f[i])) * 32767;
  return { pcm, rate: clip.rate };
}

export const clipSeconds = (clip) => clip.frames / clip.rate;
export const clipBytes = (clip) => clip.codec === 'pcm' ? clip.pcm.byteLength : clip.chunks.reduce((n, c) => n + c.byteLength, 0) + 16 * clip.chunks.length;

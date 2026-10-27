const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WINDOWS_EPOCH_SECONDS = 11_644_473_600;
const GEC_PREFIX = "Copyright (C) Microsoft Corporation. All rights reserved.";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function toWords(bytes: Uint8Array): number[] {
  const padded = new Uint8Array(Math.ceil(bytes.length / 8) * 8);
  padded.set(bytes);
  const view = new DataView(padded.buffer);
  return Array.from({ length: padded.length / 4 }, (_, index) => view.getUint32(index * 4, true));
}

function rol16(value: number): number {
  return ((value << 16) | (value >>> 16)) >>> 0;
}

function cs64WordSwap(words: number[], a: number, b: number): [number, number] {
  let acc = 0;
  let last = 0;
  for (let index = 0; index < words.length; index += 2) {
    const x = words[index]!;
    const y = words[index + 1]!;
    let value = rol16((Math.imul(rol16(x), 0xef0569fb) + Math.imul(x, a)) >>> 0);
    let q = Math.imul(value, 0x76f50f34) >>> 0;
    acc = (acc + Math.imul(rol16(q), 0xc3efea97) + q) >>> 0;
    value = rol16((Math.imul(rol16(y), 0xc31713db) + Math.imul(y, b)) >>> 0);
    q = Math.imul(value, 0x1881ce3c) >>> 0;
    last = (Math.imul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    acc = (acc + last) >>> 0;
  }
  return [last, acc];
}

function cs64Reversible(words: number[], a: number, b: number): [number, number] {
  let state = 0;
  let acc = 0;
  for (let index = 0; index < words.length; index += 2) {
    state = Math.imul(state + words[index]!, a) >>> 0;
    for (const constant of [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83]) {
      state = Math.imul(rol16(state), constant) >>> 0;
    }
    let value = Math.imul(words[index + 1]! + state, b) >>> 0;
    value = Math.imul(rol16(value), 0xa27416f5) >>> 0;
    value = rol16(Math.imul(rol16(value), 0xd38396ff) >>> 0);
    acc = (acc + state) >>> 0;
    state = Math.imul(rol16(Math.imul(value, 0x7c932b89) >>> 0), 0xbfa49f69) >>> 0;
    acc = (acc + state) >>> 0;
  }
  return [state, acc];
}

/** Current v2 Edge Read Aloud handshake token, using the algorithm merged by edge-tts upstream. */
export async function generateEdgeTtsToken(now = Date.now()): Promise<string> {
  let seconds = Math.floor(now / 1000) + WINDOWS_EPOCH_SECONDS;
  seconds -= seconds % 300;
  // Keep the same floating-point conversion and decimal formatting as the upstream implementation.
  const ticks = (seconds * 10_000_000).toFixed(0);
  const suffix = new TextEncoder().encode(`${ticks}${TRUSTED_CLIENT_TOKEN}`);
  const prefix = new TextEncoder().encode(GEC_PREFIX);
  const data = new Uint8Array(prefix.length + suffix.length);
  data.set(prefix);
  data.set(suffix, prefix.length);

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const [key0, key1] = toWords(digest);
  const a = (key0! | 1) >>> 0;
  const b = (key1! | 1) >>> 0;
  const words = toWords(data);
  const [s0, s1] = cs64WordSwap(words, a, b);
  const [r0, r1] = cs64Reversible(words, a, b);
  const cs64 = new DataView(new ArrayBuffer(8));
  cs64.setUint32(0, s0 ^ r0, true);
  cs64.setUint32(4, s1 ^ r1, true);
  return `${toHex(new Uint8Array(cs64.buffer))}-${toHex(digest)}`;
}

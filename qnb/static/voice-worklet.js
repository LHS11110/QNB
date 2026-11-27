"use strict";

/* Voice channel DSP running on the audio thread.
 * Wire format: 16 kHz mono G.711 mu-law, 640 samples (40 ms) per frame.
 * qnb-capture  : microphone → resample → mu-law frames posted to the main thread.
 * qnb-playback : server-relayed frames per speaker → jitter buffer → resample → mix.
 */

const WIRE_RATE = 16000;
const FRAME = 640;

function encodeMuLaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let pcm = Math.max(-1, Math.min(1, sample)) * 32767;
  const sign = pcm < 0 ? 0x80 : 0;
  if (sign) pcm = -pcm;
  pcm = Math.min(CLIP, pcm) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const DECODE = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const value = ~i & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  DECODE[i] = (sign ? -magnitude : magnitude) / 32768;
}

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Input samples between two 16 kHz output samples (e.g. 48000 / 16000 = 3).
    this.ratio = sampleRate / WIRE_RATE;
    this.phase = 0;
    this.previous = 0;
    this.frame = new Uint8Array(FRAME);
    this.filled = 0;
    this.energy = 0;
  }

  process(inputs, outputs) {
    const channel = inputs[0]?.[0];
    if (outputs[0]?.[0]) outputs[0][0].fill(0);
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const current = channel[i];
      // phase = position of the next output sample between previous (0) and current (1) input.
      while (this.phase < 1) {
        const sample = this.previous + (current - this.previous) * this.phase;
        this.frame[this.filled++] = encodeMuLaw(sample);
        this.energy += sample * sample;
        if (this.filled === FRAME) {
          const level = Math.sqrt(this.energy / FRAME);
          this.port.postMessage({ frame: this.frame, level }, [this.frame.buffer]);
          this.frame = new Uint8Array(FRAME);
          this.filled = 0;
          this.energy = 0;
        }
        this.phase += this.ratio;
      }
      this.phase -= 1;
      this.previous = current;
    }
    return true;
  }
}

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = WIRE_RATE / sampleRate;
    this.speakers = new Map();
    this.levelClock = 0;
    this.port.onmessage = ({ data }) => {
      if (data.reset) { this.speakers.clear(); return; }
      if (data.drop) { this.speakers.delete(data.drop); return; }
      let speaker = this.speakers.get(data.slot);
      if (!speaker) {
        speaker = { buffer: new Float32Array(WIRE_RATE * 2), read: 0, write: 0, playing: false, position: 0, energy: 0, count: 0 };
        this.speakers.set(data.slot, speaker);
      }
      const size = speaker.buffer.length;
      for (let i = 0; i < data.data.length; i++) {
        speaker.buffer[speaker.write % size] = DECODE[data.data[i]];
        speaker.write++;
      }
      // Bound latency: if more than 400 ms is queued, skip ahead to keep ~100 ms.
      if (speaker.write - speaker.read > WIRE_RATE * 0.4) {
        speaker.read = speaker.write - WIRE_RATE * 0.1;
        speaker.position = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    out.fill(0);
    for (const speaker of this.speakers.values()) {
      const size = speaker.buffer.length;
      const buffered = speaker.write - speaker.read;
      if (!speaker.playing) {
        if (buffered < FRAME * 2) continue; // 80 ms jitter buffer before (re)starting
        speaker.playing = true;
      }
      for (let i = 0; i < out.length; i++) {
        if (speaker.write - speaker.read < 2) { speaker.playing = false; break; }
        const a = speaker.buffer[speaker.read % size];
        const b = speaker.buffer[(speaker.read + 1) % size];
        const sample = a + (b - a) * speaker.position;
        out[i] += sample;
        speaker.energy += sample * sample;
        speaker.count++;
        speaker.position += this.step;
        while (speaker.position >= 1) { speaker.position -= 1; speaker.read++; }
      }
    }
    for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
    this.levelClock += out.length;
    if (this.levelClock >= sampleRate / 10) {
      this.levelClock = 0;
      const levels = {};
      for (const [slot, speaker] of this.speakers) {
        levels[slot] = speaker.count ? Math.sqrt(speaker.energy / speaker.count) : 0;
        speaker.energy = 0;
        speaker.count = 0;
      }
      this.port.postMessage({ levels });
    }
    return true;
  }
}

registerProcessor("qnb-capture", CaptureProcessor);
registerProcessor("qnb-playback", PlaybackProcessor);

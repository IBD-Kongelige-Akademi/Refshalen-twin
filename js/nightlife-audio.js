// js/nightlife-audio.js
// The beats from the bars, pubs and nightclubs (pure side: js/nightlife.js). Only the few venues the listener hears loudest play
// (2-3 voices, js/audio-system.js limits), each a looping AudioBuffer of its style and tempo (rendered once per style/tempo by
// renderBeatLoop, then shared) through the city's SpatialEmitter: HRTF panning at the venue's door, inverse roll-off with distance,
// a fade at the edge of the venue's range, and the muffling of the acoustics (around a corner the beat is a thud of kick and bass).
// The loops start on a grid of the audio clock (offset = clock mod loop), and js/nightlife-scene.js flashes the lights on the same
// clock, so the light pulses on the beat you hear. No per-frame allocation: a voice is only built when a venue comes into range.

import { selectAudible, venueGain, renderBeatLoop } from './nightlife.js';

const SOURCE_HEIGHT = 1.4; // m: the open door
const SOURCE_OUT = 1.2; // m in front of the wall, so the street side is not "behind the building" for the obstruction test

export class NightlifeAudio {
  /**
   * @param context      AudioContext
   * @param dry          the mix bus
   * @param reflections  the shared reflection send
   * @param acoustics    js/audio-acoustics.js CityAcoustics
   * @param Emitter      js/audio-system.js SpatialEmitter (passed in to keep the module graph acyclic)
   * @param limit        voices at once
   */
  constructor(context, dry, reflections, acoustics, Emitter, limit = 3) {
    Object.assign(this, { context, dry, reflections, acoustics, Emitter, limit });
    this.buffers = new Map(); // `${style}:${bpm}` -> AudioBuffer
    this.voices = new Map(); // venue -> { src, emitter, source, selected, retire }
    this.chosen = [];
    this.scratch = [];
  }

  buffer(look) {
    const key = `${look.style}:${look.bpm}`;
    let b = this.buffers.get(key);
    if (!b) {
      const rate = this.context.sampleRate;
      const loop = renderBeatLoop(look.style, look.bpm, rate, { seed: (look.bpm * 0.6180339) % 1 });
      b = this.context.createBuffer(1, loop.samples.length, rate);
      b.copyToChannel(loop.samples, 0);
      this.buffers.set(key, b);
    }
    return b;
  }

  start(v, now) {
    const look = v.look;
    const emitter = new this.Emitter(this.context, this.dry, this.reflections, this.acoustics, look.style === 'club' ? 7 : 5, SOURCE_HEIGHT);
    const src = this.context.createBufferSource();
    src.buffer = this.buffer(look);
    src.loop = true;
    src.connect(emitter.input);
    // on the audio clock's beat grid, shifted by the venue's phase (the scene's light pulse uses the same grid)
    const when = now + 0.05;
    const beat = 60 / look.bpm;
    const offset = (((when / beat + look.phase) * beat) % src.buffer.duration + src.buffer.duration) % src.buffer.duration;
    src.start(when, offset);
    const source = { x: v.x + v.nx * SOURCE_OUT, y: v.y || 0, z: v.z + v.nz * SOURCE_OUT, gain: 0, seed: look.seed * 97 };
    return { src, emitter, source, selected: true, retire: 0, fresh: true };
  }

  stop(slot) {
    try { slot.src.stop(); } catch { /* never started */ }
    slot.src.disconnect();
    slot.emitter.dispose();
  }

  /** Every 0.1 s from the audio system: (listener {x, y, z}, audio clock, js/nightlife.js state). */
  update(listener, now, state) {
    const level = state.level;
    const venues = state.venues;
    if (level > 0.01 && venues.length) selectAudible(venues, listener.x, listener.z, this.limit, this.chosen, this.scratch);
    else this.chosen.length = 0;
    for (const slot of this.voices.values()) slot.selected = false;
    for (const i of this.chosen) {
      const v = venues[i];
      let slot = this.voices.get(v);
      if (!slot) {
        if (this.voices.size >= this.limit) continue; // a retiring voice still holds its place
        slot = this.start(v, now);
        this.voices.set(v, slot);
      }
      slot.selected = true;
      slot.retire = 0;
      slot.source.y = v.y || 0;
      slot.source.gain = venueGain(v.look, level);
      slot.emitter.update(slot.source, listener, now, v.look.range, slot.fresh);
      slot.fresh = false;
    }
    for (const [v, slot] of this.voices) {
      if (slot.selected) continue;
      if (!slot.retire) {
        slot.emitter.input.gain.cancelScheduledValues(now);
        slot.emitter.input.gain.setTargetAtTime(0, now, 0.25);
        slot.retire = now + 1.2;
      } else if (now >= slot.retire) {
        this.stop(slot);
        this.voices.delete(v);
      }
    }
  }

  reset() {
    for (const slot of this.voices.values()) this.stop(slot);
    this.voices.clear();
  }

  dispose() {
    this.reset();
    this.buffers.clear();
  }

  get playing() { return this.voices.size; }
}

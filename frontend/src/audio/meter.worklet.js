/**
 * AudioWorklet processor: measures the decoded audio on the audio thread and
 * posts one SubBlock every 100 ms to the page (see engine.ts).
 */
import { MeterCore } from './dsp';
class LevelMeterProcessor extends AudioWorkletProcessor {
  core = new MeterCore(sampleRate);
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      for (const block of this.core.process(input)) this.port.postMessage(block);
    }
    return true;
  }
}
registerProcessor('level-meter', LevelMeterProcessor);

// NES 音频处理器：在音频线程缓冲样本并按输出采样率播放
class NesAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = new Float32Array(8192)
    this.readPos = 0
    this.writePos = 0
    this.fadeSamples = 0
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "reset") {
        this.readPos = this.writePos
        this.fadeSamples = 256 * 2
        return
      }
      const data = e.data.samples
      if (!data || !data.length) return
      // 写入前丢弃最旧样本，不能让写指针覆盖仍未播放的数据
      const capacity = this.queue.length
      const keep = Math.min(data.length, capacity)
      const drop = data.length - keep
      if (this.writePos - this.readPos + keep > capacity) {
        this.readPos = this.writePos + keep - capacity
      }
      for (let i = drop; i < data.length; i++) {
        this.queue[this.writePos % capacity] = data[i]
        this.writePos++
      }
    }
  }

  // 每个音频回调周期输出 128 帧双声道样本
  process(inputs, outputs) {
    const out = outputs[0]
    const left = out[0]
    const right = out[1] || out[0]
    for (let i = 0; i < left.length; i++) {
      if (this.readPos + 1 < this.writePos) {
        left[i] = this.queue[this.readPos % 8192]
        right[i] = this.queue[(this.readPos + 1) % 8192]
        this.readPos += 2
        if (this.fadeSamples > 0) {
          const gain = 1 - this.fadeSamples / (256 * 2)
          left[i] *= gain
          right[i] *= gain
          this.fadeSamples = Math.max(0, this.fadeSamples - 2)
        }
      } else {
        left[i] = 0
        right[i] = 0
      }
    }
    return true
  }
}

registerProcessor("nes-audio", NesAudioProcessor)

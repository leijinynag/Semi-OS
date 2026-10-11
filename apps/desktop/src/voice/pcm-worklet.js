/* 设备常驻但门控默认关闭；空闲采样立即丢弃，绝不维护按键前缓冲。 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.token = undefined;
    this.port.onmessage = ({ data }) => {
      if (data.kind === "begin") this.token = data.token;
      if (data.kind === "end") {
        if (this.token === data.token) this.token = undefined;
        // MessagePort 保序：确认之前的采样全部属于该 token。
        this.port.postMessage({ kind: "flushed", token: data.token });
      }
    };
  }
  process(inputs) {
    if (this.token !== undefined && inputs[0]?.[0]) {
      const samples = inputs[0][0].slice();
      this.port.postMessage({ kind: "samples", token: this.token, samples }, [samples.buffer]);
    }
    return true;
  }
}
registerProcessor("semi-os-capture", CaptureProcessor);

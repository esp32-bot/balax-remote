import createEclDecoderWasm from "./eclDecoderWasm.mjs";

interface EclWasmModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _ecl_dec_create(maxFrameBytes: number, maxBlocks: number): number;
  _ecl_dec_destroy(ctx: number): void;
  _ecl_dec_reset(ctx: number): void;
  _ecl_dec_decode(
    ctx: number,
    codecMode: number,
    frameId: number,
    refFrameId: number,
    isKeyframe: number,
    width: number,
    height: number,
    inPtr: number,
    inLen: number,
    outPtr: number,
    outCap: number,
  ): number;
}

export class WasmTemporalDecoder {
  private readonly mod: EclWasmModule;
  private readonly ctx: number;
  private readonly inPtr: number;
  private readonly outPtr: number;
  private readonly cap: number;
  public decodeErrors = 0;

  private constructor(mod: EclWasmModule, maxFrameBytes: number, maxBlocks: number) {
    this.mod = mod;
    this.cap = maxFrameBytes;
    this.ctx = mod._ecl_dec_create(maxFrameBytes, maxBlocks);
    if (!this.ctx) {
      throw new Error("ecl_dec_create failed");
    }
    this.inPtr = mod._malloc(maxFrameBytes);
    this.outPtr = mod._malloc(maxFrameBytes);
  }

  static async create(maxFrameBytes = 131072, maxBlocks = 4096): Promise<WasmTemporalDecoder> {
    const mod = (await createEclDecoderWasm()) as unknown as EclWasmModule;
    return new WasmTemporalDecoder(mod, maxFrameBytes, maxBlocks);
  }

  reset(): void {
    this.mod._ecl_dec_reset(this.ctx);
  }

  decodeBytes(
    codecMode: number,
    frameId: number,
    refFrameId: number,
    isKeyframe: boolean,
    width: number,
    height: number,
    payload: Uint8Array,
  ): Uint8Array | null {
    if (payload.length > this.cap) {
      this.decodeErrors++;
      return null;
    }
    if (payload.length > 0) {
      this.mod.HEAPU8.set(payload, this.inPtr);
    }
    const outLen = this.mod._ecl_dec_decode(
      this.ctx,
      codecMode,
      frameId >>> 0,
      refFrameId >>> 0,
      isKeyframe ? 1 : 0,
      width & 0xffff,
      height & 0xffff,
      this.inPtr,
      payload.length,
      this.outPtr,
      this.cap,
    );
    if (outLen <= 0) {
      this.decodeErrors++;
      return null;
    }
    return this.mod.HEAPU8.slice(this.outPtr, this.outPtr + outLen);
  }

  decode(
    codecMode: number,
    frameId: number,
    refFrameId: number,
    isKeyframe: boolean,
    width: number,
    height: number,
    payload: Uint8Array,
  ): Uint8Array | null {
    const out = this.decodeBytes(codecMode, frameId, refFrameId, isKeyframe, width, height, payload);
    if (!out) return null;
    const NodeBuf = (globalThis as { Buffer?: { from(buf: ArrayBufferLike, offset: number, len: number): Uint8Array } }).Buffer;
    return NodeBuf ? NodeBuf.from(out.buffer, out.byteOffset, out.byteLength) : out;
  }

  destroy(): void {
    this.mod._ecl_dec_destroy(this.ctx);
    this.mod._free(this.inPtr);
    this.mod._free(this.outPtr);
  }
}

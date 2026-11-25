declare function createEclDecoder(): Promise<{
  HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _ecl_dec_create(): number;
  _ecl_dec_destroy(ctx: number): void;
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
}>;
export default createEclDecoder;

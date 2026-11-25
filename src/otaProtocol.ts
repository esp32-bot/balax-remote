export type OtaJobPhase =
  | "building"
  | "preflight"
  | "entering-stub"
  | "compressing"
  | "uploading"
  | "verifying"
  | "done"
  | "error";

export interface OtaJobSnapshot {
  id: string;
  active: boolean;
  status: "running" | "done" | "error";
  phase: OtaJobPhase;
  progress: number;
  wireBytes: number;
  totalBytes: number;
  rawBytes: number;
  compressed: boolean;
  partition: string | null;
  message: string;
  error: string | null;
  startedAtMs: number;
  updatedAtMs: number;
}

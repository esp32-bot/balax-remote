export type UsbFlashLayout = "standard" | "compact";

export interface UsbFlashJob {
  id: string;
  layout: UsbFlashLayout;
  port: string;
  status: "running" | "succeeded" | "failed";
  phase: "preflight" | "writing" | "done";
  progress: number;
  log: string[];
  error: string | null;
}

export interface UsbLayoutReadiness {
  ready: boolean;
  error: string | null;
}

export interface UsbFlashInfo {
  local: boolean;
  ports: string[];
  ready: boolean;
  layouts: Record<UsbFlashLayout, UsbLayoutReadiness>;
  job: UsbFlashJob | null;
}

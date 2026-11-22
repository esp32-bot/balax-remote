export interface FlashPartitionEntry {
  name: string;
  type: string;
  subtype: string;
  offset: number;
  size: number;
  imageBytes: number | null;
  flags: string[];
  state: string | null;
  version: string | null;
}

export interface FlashLayout {
  totalBytes: number;
  partitions: FlashPartitionEntry[];
  fetchedAtMs: number;
}

export interface FlashSnapshot {
  connected: boolean;
  revision: number;
  status: "live" | "offline" | "unsupported" | "busy" | "error";
  live: FlashLayout | null;
  error: string | null;
}

const FLASH_SIZE = /^flash_size\s+(0x[\da-f]+)$/i;
const PARTITION_ROW = /^(.+?)\s+(\S+)\s+(\S+)\s+(0x[\da-f]+)\s+(0x[\da-f]+)\s+(0x[\da-f]+|-)\s+(\S+)\s+(\S+)\s+(.+)$/i;

export function parseFlashPartitions(output: string, fetchedAtMs = Date.now()): FlashLayout {
  let totalBytes = 0;
  const partitions: FlashPartitionEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const flashSize = trimmed.match(FLASH_SIZE);
    if (flashSize) {
      totalBytes = Number(flashSize[1]);
      continue;
    }
    const row = trimmed.match(PARTITION_ROW);
    if (!row) continue; // The command shares a log ring with ESP-IDF messages.
    const [, name, type, subtype, offset, size, image, flags, state, version] = row;
    partitions.push({
      name,
      type,
      subtype,
      offset: Number(offset),
      size: Number(size),
      imageBytes: image === "-" ? null : Number(image),
      flags: flags === "-" ? [] : flags.split(","),
      state: state === "-" ? null : state,
      version: version === "-" ? null : version,
    });
  }

  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || partitions.length === 0 ||
      partitions.some((p) => p.size <= 0 || p.offset + p.size > totalBytes ||
        (p.imageBytes !== null && p.imageBytes > p.size))) {
    throw new Error("Invalid flash partition table returned by BalaX.");
  }
  return { totalBytes, partitions, fetchedAtMs };
}

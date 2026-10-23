/**
 * The `transfer-tuning: auto` rules: the part size and the concurrency for one transfer, from the
 * object size and the provider. Pure on purpose, so any CI front end can use it. The values come
 * from the size sweep in benchmark run 39905131759 (128, 512 and 2048 MiB on AWS S3, Cloudflare
 * R2 and Google Cloud Storage, on a 4-CPU runner); the benchmark page lists the measurements.
 */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** S3 accepts at most this many parts in one multipart upload. */
const MAX_UPLOAD_PARTS = 10_000;
/** The input limits for `upload-chunk-size` and `download-chunk-size`. */
const MAX_PART_SIZE = 128 * MiB;
/** At most this many bytes in flight, whatever the free memory. */
const MAX_BUFFERED_BYTES = 1 * GiB;

export interface TuningInput {
  direction: 'upload' | 'download';
  sizeBytes: number;
  /** The resolved provider name, for example `aws`, `r2` or `gcs`. */
  provider: string;
  /** `os.freemem()` when the transfer starts. A quarter of it is the buffer budget. */
  freeMemoryBytes: number;
}

export interface TransferSettings {
  concurrency: number;
  partSize: number;
}

/**
 * Downloads: 16 MiB parts, 16 at a time. Every provider reached its top group with 128 MiB or
 * more in flight; the 8 x 8 MiB default was the slowest or close to it at every size.
 */
function downloadRule(sizeBytes: number): TransferSettings {
  const partSize = 16 * MiB;
  const parts = Math.max(1, Math.ceil(sizeBytes / partSize));
  return { concurrency: Math.min(16, parts), partSize };
}

/**
 * Uploads: 16 at a time, with 16 MiB parts up to 256 MiB and 32 MiB parts above, so a small
 * archive still gets several parts. R2 gained most from more parts in flight on a large archive,
 * so R2 uploads of 1 GiB or more use 32 x 16 MiB. The part size grows when the archive would
 * need more than 10,000 parts.
 */
function uploadRule(sizeBytes: number, provider: string): TransferSettings {
  let settings: TransferSettings =
    provider === 'r2' && sizeBytes >= GiB
      ? { concurrency: 32, partSize: 16 * MiB }
      : { concurrency: 16, partSize: sizeBytes <= 256 * MiB ? 16 * MiB : 32 * MiB };
  const minPartSize = Math.ceil(sizeBytes / MAX_UPLOAD_PARTS / MiB) * MiB;
  if (minPartSize > settings.partSize) {
    settings = { ...settings, partSize: Math.min(minPartSize, MAX_PART_SIZE) };
  }
  return settings;
}

/**
 * Returns the settings for one transfer. Concurrency times part size stays within a quarter of
 * the free memory and within 1 GiB; the concurrency goes down first, to 1 at the lowest.
 */
export function tuneTransfer(input: TuningInput): TransferSettings {
  const settings =
    input.direction === 'download'
      ? downloadRule(input.sizeBytes)
      : uploadRule(input.sizeBytes, input.provider);
  const budget = Math.min(MAX_BUFFERED_BYTES, Math.floor(input.freeMemoryBytes / 4));
  const fits = Math.max(1, Math.floor(budget / settings.partSize));
  return { ...settings, concurrency: Math.min(settings.concurrency, fits) };
}

/** `Transfer tuning: auto selected 16 x 16 MiB for the download of 2.0 GiB`. */
export function formatTuning(
  direction: 'upload' | 'download',
  settings: TransferSettings,
  sizeBytes: number
): string {
  const size =
    sizeBytes >= GiB
      ? `${(sizeBytes / GiB).toFixed(1)} GiB`
      : `${(sizeBytes / MiB).toFixed(0)} MiB`;
  return `Transfer tuning: auto selected ${settings.concurrency} x ${settings.partSize / MiB} MiB for the ${direction} of ${size}`;
}

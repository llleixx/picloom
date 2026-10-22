const concurrency = 8;
let active = 0;
const waiting: Array<() => void> = [];

async function acquire(signal: AbortSignal) {
  signal.throwIfAborted();
  if (active >= concurrency) {
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = () => {
        const index = waiting.indexOf(start);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      };
      waiting.push(start);
      signal.addEventListener("abort", cancel, { once: true });
    });
  } else active++;
}

export async function loadThumbnail(src: string, signal: AbortSignal) {
  await acquire(signal);
  try {
    signal.throwIfAborted();
    const response = await fetch(src, { signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Thumbnail request failed: ${response.status}`);
    }
    return await response.blob();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

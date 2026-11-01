export interface SaveQueue<T> {
  schedule(value: T): void;
  flush(): Promise<void>;
  dirty(): boolean;
}

interface Options<T, R> {
  save(value: T): Promise<R>;
  onSaved(result: R): void;
  onError(reason: Error): void;
  delayMs: number;
}

// Sends one save at a time, so flush() means "everything typed so far is on the server".
export function createSaveQueue<T, R>({ save, onSaved, onError, delayMs }: Options<T, R>): SaveQueue<T> {
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tail: Promise<void> = Promise.resolve();
  let newest = 0;
  let inFlight = 0;

  const flush = () => {
    clearTimeout(timer);
    if (pending) {
      const { value } = pending;
      pending = null;
      const ticket = ++newest;
      inFlight += 1;
      tail = tail
        .catch(() => {})
        .then(async () => {
          try {
            // A newer value carries this one's changes too, so sending it would only waste a request.
            if (ticket !== newest) return;
            const result = await save(value);
            if (ticket === newest && !pending) onSaved(result);
          } catch (reason) {
            // Keep the text: the next edit or flush sends it again.
            if (ticket === newest && !pending) pending = { value };
            throw reason;
          } finally {
            inFlight -= 1;
          }
        });
    }
    return tail;
  };

  return {
    schedule(value) {
      pending = { value };
      clearTimeout(timer);
      timer = setTimeout(() => flush().catch(onError), delayMs);
    },
    flush,
    dirty: () => pending !== null || inFlight > 0,
  };
}

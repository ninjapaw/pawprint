export function cached<T>(ttlMilliseconds: number, maximumEntries = 128) {
  const entries = new Map<string, { expires: number; promise: Promise<T> }>();
  return (key: string, read: () => Promise<T>): Promise<T> => {
    const existing = entries.get(key);
    if (existing && existing.expires > Date.now()) return existing.promise;
    if (entries.size >= maximumEntries) entries.delete(entries.keys().next().value ?? key);
    const promise = read();
    entries.set(key, { expires: Date.now() + ttlMilliseconds, promise });
    void promise.catch(() => {
      if (entries.get(key)?.promise === promise) entries.delete(key);
    });
    return promise;
  };
}

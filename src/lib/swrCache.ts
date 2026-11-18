import { useCallback, useEffect, useRef, useState } from 'react';

interface ClientCacheEntry<T> {
  timestamp: number;
  data: T;
}

const memoryCache = new Map<string, ClientCacheEntry<unknown>>();
const STORAGE_PREFIX = 'aurora_pulse_cache_v1:';
const CLIENT_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes client SWR window

function readStoredEntry<T>(key: string): ClientCacheEntry<T> | null {
  const mem = memoryCache.get(key) as ClientCacheEntry<T> | undefined;
  if (mem && Date.now() - mem.timestamp < CLIENT_MAX_AGE_MS) {
    return mem;
  }
  try {
    const raw = sessionStorage.getItem(`${STORAGE_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClientCacheEntry<T>;
    if (Date.now() - parsed.timestamp < CLIENT_MAX_AGE_MS) {
      memoryCache.set(key, parsed);
      return parsed;
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

function writeStoredEntry<T>(key: string, data: T): void {
  const entry: ClientCacheEntry<T> = { timestamp: Date.now(), data };
  memoryCache.set(key, entry);
  try {
    sessionStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(entry));
  } catch {
    // ignore quota errors
  }
}

export function clearAllClientCache(): void {
  memoryCache.clear();
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(STORAGE_PREFIX)) keysToRemove.push(k);
    }
    for (const k of keysToRemove) {
      sessionStorage.removeItem(k);
    }
  } catch {
    // ignore
  }
}

export function useCachedPage<T>(url: string) {
  const initial = readStoredEntry<T>(url);
  const [data, setData] = useState<T | null>(initial?.data ?? null);
  const [loading, setLoading] = useState<boolean>(!initial);
  const [revalidating, setRevalidating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchPage = useCallback(
    async (opts?: { force?: boolean; silent?: boolean }) => {
      const cached = opts?.force ? null : readStoredEntry<T>(url);
      if (cached && !opts?.silent) {
        setData(cached.data);
        setLoading(false);
        setRevalidating(true);
      } else if (!cached && !opts?.silent) {
        setLoading(true);
      } else {
        setRevalidating(true);
      }

      setError(null);
      try {
        const targetUrl = opts?.force
          ? `${url}${url.includes('?') ? '&' : '?'}force=true`
          : url;
        const res = await fetch(targetUrl);
        const json = await res.json();
        if (!res.ok) {
          throw new Error((json as { error?: string }).error || 'Failed to load page data');
        }
        writeStoredEntry(url, json as T);
        if (mountedRef.current) {
          setData(json as T);
        }
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : 'Unable to reach Aimfox API');
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
          setRevalidating(false);
        }
      }
    },
    [url],
  );

  useEffect(() => {
    const cached = readStoredEntry<T>(url);
    if (cached) {
      setData(cached.data);
      setLoading(false);
    }
    fetchPage({ silent: Boolean(cached) });
  }, [url, fetchPage]);

  const mutate = useCallback(
    (updater: (prev: T | null) => T | null) => {
      setData((prev) => {
        const next = updater(prev);
        if (next) writeStoredEntry(url, next);
        return next;
      });
    },
    [url],
  );

  return { data, loading, revalidating, error, refresh: fetchPage, mutate };
}

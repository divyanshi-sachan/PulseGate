import { useEffect, useState } from 'react';
import { ApiError } from './client.ts';

export type Resource<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: ApiError };

/**
 * Loads one admin API resource for a component. A 401 is never shown as an error on a screen: it calls
 * `onUnauthorized`, which sends the user back to the token gate. Polling and staleness come with the screens (step 5).
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  onUnauthorized: () => void,
): Resource<T> {
  const [resource, setResource] = useState<Resource<T>>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResource({ status: 'ready', data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.kind === 'unauthorized') {
          onUnauthorized();
          return;
        }
        setResource({
          status: 'error',
          error:
            error instanceof ApiError
              ? error
              : new ApiError(
                  'invalid-response',
                  error instanceof Error ? error.message : 'Unexpected error',
                ),
        });
      },
    );
    return () => {
      controller.abort();
    };
  }, [load, onUnauthorized]);
  return resource;
}

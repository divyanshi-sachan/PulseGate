import type { AdminApi } from '../api/client.ts';

/** Every screen gets the API client and a way back to the token gate. */
export interface ScreenProps {
  api: AdminApi;
  onUnauthorized: () => void;
}

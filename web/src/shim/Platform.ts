// Browser shim for `src/components/Global/Platform.ts`.
// The rendering engine only ever needs an access token for the lyrics API.
import { getAccessToken, invalidateAccessToken } from "../spotify/auth.ts";

const Platform = {
  GetSpotifyAccessToken: async (): Promise<string> => {
    return (await getAccessToken()) ?? "";
  },
  // The engine calls this when the lyrics API answers 401: the token looked
  // valid to us and the server disagreed. Our OAuth token lives in
  // `spotify/auth.ts`, so hand the rejection there — it forces the next
  // `GetSpotifyAccessToken` through a refresh rather than returning the same
  // refused string.
  InvalidateSpotifyAccessToken: (token?: string): void => {
    invalidateAccessToken(token);
  },
  OnSpotifyReady: Promise.resolve(),
  Session: {},
};

export default Platform;

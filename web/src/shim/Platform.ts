// Browser shim for `src/components/Global/Platform.ts`.
// The rendering engine only ever needs an access token for the lyrics API.
import { getAccessToken } from "../spotify/auth.ts";

const Platform = {
  GetSpotifyAccessToken: async (): Promise<string> => {
    return (await getAccessToken()) ?? "";
  },
  OnSpotifyReady: Promise.resolve(),
  Session: {},
};

export default Platform;

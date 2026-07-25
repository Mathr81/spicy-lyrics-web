// Browser shim for `src/utils/Lyrics/ProcessLyrics.ts`.
//
// The real module performs on-device romanization (Kuroshiro/Kuromoji, franc,
// pinyin…) by dynamically importing packages from an external CDN at load time.
// The standalone build relies on the transliterations the lyrics API already
// ships (`TransliteratedText`), so this is a no-op — keeping the bundle small
// and free of any third-party CDN dependency at runtime.

export const ProcessLyrics = async (_lyrics: unknown): Promise<void> => {
  /* no-op: romanization comes from the API payload */
};

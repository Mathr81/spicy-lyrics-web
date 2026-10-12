// Stand-in for the `@pixi/*` packages.
//
// AMLL's bundle (@applemusic-like-lyrics/core) imports pixi.js at its top level
// for `PixiRenderer`, a background renderer this build never constructs — the
// Apple Music view only uses its lyric player. Aliasing those imports here (see
// vite.config.ts) keeps pixi out of the lazy chunk, about a quarter of its size.
export class Application {}
export class Texture {}
export class Container {}
export class Sprite {}
export class BlurFilter {}
export class BulgePinchFilter {}
export class ColorMatrixFilter {}
export const utils = {};

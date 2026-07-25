import { defineConfig, type Plugin } from "vite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const R = (p: string) => path.resolve(dir, p);

/**
 * The standalone web build reuses the *real* Spicy Lyrics rendering engine
 * (Animator, Applyer, virtualizer, CSS) straight from `src/`. Only the handful
 * of modules that are tightly coupled to the `window.Spicetify` runtime are
 * swapped for browser-friendly shims. This plugin redirects the fully-resolved
 * absolute path of each original module to its shim.
 */
function swapModules(map: Record<string, string>): Plugin {
  const resolved = new Map<string, string>(
    Object.entries(map).map(([from, to]) => [R(from), R(to)])
  );
  return {
    name: "spicy-swap-modules",
    enforce: "pre",
    resolveId(source, importer) {
      // Absolute source (rare) — match directly.
      if (path.isAbsolute(source) && resolved.has(source)) {
        return resolved.get(source)!;
      }
      if (!importer) return null;
      if (!source.startsWith(".")) return null;
      const abs = path.resolve(path.dirname(importer), source);
      const hit = resolved.get(abs);
      return hit ?? null;
    },
  };
}

/**
 * The engine's imports were authored on a case-insensitive filesystem (macOS),
 * so some resolve to a differently-cased file (e.g. `./logger` -> `Logger.ts`)
 * and some omit the extension. Rollup on Linux is strict about both. This
 * plugin retries a failed relative resolve case-insensitively across common
 * extensions.
 */
const EXTS = ["", ".ts", ".tsx", ".js", ".mjs", ".json", ".css", ".scss"];
function caseInsensitiveResolve(): Plugin {
  return {
    name: "spicy-ci-resolve",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source.startsWith(".")) return null;
      const base = path.resolve(path.dirname(importer), source);
      for (const e of EXTS) if (fs.existsSync(base + e)) return null; // exact hit
      const dir = path.dirname(base);
      if (!fs.existsSync(dir)) return null;
      const wanted = path.basename(base).toLowerCase();
      const entries = fs.readdirSync(dir);
      for (const e of EXTS) {
        const target = wanted + e;
        const found = entries.find((f) => f.toLowerCase() === target);
        if (found) return path.join(dir, found);
      }
      return null;
    },
  };
}

export default defineConfig({
  root: R("web"),
  base: "./",
  plugins: [
    swapModules({
      "src/components/Global/SpotifyPlayer.ts": "web/src/shim/SpotifyPlayer.ts",
      "src/components/Global/Platform.ts": "web/src/shim/Platform.ts",
      "src/components/Pages/PageView.ts": "web/src/shim/PageView.ts",
      "src/components/Utils/Fullscreen.ts": "web/src/shim/Fullscreen.ts",
      "src/components/Utils/CompactMode.ts": "web/src/shim/CompactMode.ts",
      "src/components/DynamicBG/dynamicBackground.ts": "web/src/shim/dynamicBackground.ts",
      "src/utils/Lyrics/Applyer/Credits/ApplyIsByCommunity.tsx":
        "web/src/shim/ApplyIsByCommunity.ts",
      // Drop the on-device romanization pipeline (Kuroshiro/franc + CDN loads);
      // the standalone uses API-provided transliterations instead.
      "src/utils/Lyrics/ProcessLyrics.ts": "web/src/shim/ProcessLyrics.ts",
    }),
    caseInsensitiveResolve(),
  ],
  resolve: {
    alias: {
      // Let reused files import from the repo `src/` tree unchanged.
      "@src": R("src"),
    },
  },
  build: {
    outDir: R("web/dist"),
    emptyOutDir: true,
    target: "es2020",
    sourcemap: false,
  },
});

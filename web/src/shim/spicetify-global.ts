// Installs a minimal `window.Spicetify` so engine modules that touch it at
// evaluation time (notably `src/utils/stores.ts`, which reads
// `Spicetify.LocalStorage`) work in a plain browser. Imported FIRST from main.ts
// so it runs before any engine module is evaluated.

const noop = () => {};

const LocalStorage = {
  get: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string): void => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  },
  remove: (key: string): void => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

if (!(window as any).Spicetify) {
  (window as any).Spicetify = {
    LocalStorage,
    Player: { isPlaying: () => false, getProgress: () => 0, addEventListener: noop },
    Platform: {},
    Tippy: () => ({ destroy: noop, setContent: noop }),
    TippyProps: {},
    Menu: { Item: class { register() {} } },
    Keyboard: { registerImportantShortcut: noop, KEYS: {} },
    showNotification: noop,
  };
}

export {};

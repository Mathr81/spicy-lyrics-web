// Minimalist chrome: a centered login card when logged out, and an unobtrusive
// status line. All playback / fullscreen / romanization controls live on the
// cover (see mediabox.ts), exactly like the extension.

export interface ShellCallbacks {
  onLogin: () => void;
}

export interface ShellHandle {
  setLoggedIn: (v: boolean) => void;
  setStatus: (text: string) => void;
}

export function renderShell(root: HTMLElement, cb: ShellCallbacks): ShellHandle {
  const login = document.createElement("div");
  login.className = "sl-login-overlay";
  login.innerHTML = `
    <div class="sl-login-card">
      <div class="sl-login-title">Spicy Lyrics</div>
      <button class="sl-login-btn" type="button">Se connecter à Spotify</button>
    </div>
  `;
  login.hidden = true; // shown only when we know the user is logged out
  root.appendChild(login);
  login.querySelector<HTMLButtonElement>(".sl-login-btn")!.addEventListener("click", cb.onLogin);

  const status = document.createElement("div");
  status.className = "sl-status";
  root.appendChild(status);

  let statusTimer: number | undefined;

  return {
    setLoggedIn(v) {
      login.hidden = v;
    },
    setStatus(text) {
      status.textContent = text;
      status.classList.toggle("visible", !!text);
      window.clearTimeout(statusTimer);
      if (text) {
        // Auto-fade non-critical status after a while.
        statusTimer = window.setTimeout(() => status.classList.remove("visible"), 6000);
      }
    },
  };
}

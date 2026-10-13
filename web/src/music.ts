// The music panel: what plays next, and a search to play or queue something
// else — the two reasons there were to leave for the Spotify app.
//
// With the search box empty it lists the queue; typing replaces that with
// results. The queue is read-only because the Web API offers nothing else: it
// can neither reorder it nor jump to an entry.
import { getQueue, searchTracks, type SimpleTrack } from "./spotify/api.ts";
import { getSnapshot, onUpdate, play, queueTrack } from "./spotify/player.ts";

const SEARCH_DELAY_MS = 300;

export interface MusicHandle {
  open: () => void;
}

export function setupMusic(): MusicHandle {
  const overlay = document.createElement("div");
  // The settings overlay's shell: same card, same iOS standalone correction.
  overlay.className = "sl-settings-overlay sl-music";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="sl-settings-card" role="dialog" aria-label="Musique">
      <div class="sl-music-head">
        <div class="sl-settings-title">Musique</div>
        <a class="sl-settings-reset" target="_blank" rel="noopener">Ouvrir dans Spotify</a>
      </div>
      <input class="sl-music-search" type="search" enterkeyhint="search"
        placeholder="Rechercher un titre" aria-label="Rechercher un titre">
      <div class="sl-music-label" aria-live="polite"></div>
      <div class="sl-music-list"></div>
      <button class="sl-settings-close" type="button">Fermer</button>
    </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector<HTMLInputElement>(".sl-music-search")!;
  const label = overlay.querySelector<HTMLElement>(".sl-music-label")!;
  const list = overlay.querySelector<HTMLElement>(".sl-music-list")!;
  const spotifyLink = overlay.querySelector<HTMLAnchorElement>("a")!;

  const close = () => {
    overlay.hidden = true;
  };
  overlay.querySelector(".sl-settings-close")!.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  /** Cover, title and artists. Text goes in as text: it is Spotify's, not ours. */
  function describe(track: SimpleTrack, into: HTMLElement): void {
    const cover = document.createElement("img");
    cover.className = "sl-music-cover";
    cover.alt = "";
    cover.loading = "lazy";
    if (track.thumb ?? track.cover) cover.src = (track.thumb ?? track.cover)!;
    const text = document.createElement("span");
    text.className = "sl-music-text";
    const name = document.createElement("span");
    name.className = "sl-music-name";
    name.textContent = track.name;
    const artists = document.createElement("span");
    artists.className = "sl-music-artists";
    artists.textContent = track.artists.map((a) => a.name).join(", ");
    text.append(name, artists);
    into.append(cover, text);
  }

  const refused = () => {
    label.textContent = "Spotify n'a pas pris la commande. Vérifie que la lecture est lancée.";
  };

  function searchRow(track: SimpleTrack): HTMLElement {
    const row = document.createElement("div");
    row.className = "sl-music-row";
    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className = "sl-music-play";
    playButton.setAttribute("aria-label", `Lire ${track.name}`);
    describe(track, playButton);
    playButton.addEventListener("click", () => {
      // Closed on success: the point of playing it is to read its lyrics.
      play(track.uri).then(close, refused);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "sl-music-add";
    add.textContent = "+";
    add.setAttribute("aria-label", `Ajouter ${track.name} à la file d'attente`);
    add.addEventListener("click", () => {
      queueTrack(track.uri).then(() => {
        add.textContent = "✓";
        add.disabled = true;
      }, refused);
    });
    row.append(playButton, add);
    return row;
  }

  function queueRow(track: SimpleTrack): HTMLElement {
    const row = document.createElement("div");
    row.className = "sl-music-row";
    describe(track, row);
    return row;
  }

  // Answers arrive out of order while typing; only the latest request counts.
  let request = 0;
  async function refresh(): Promise<void> {
    const mine = ++request;
    const query = input.value.trim();
    try {
      const tracks = query ? await searchTracks(query) : await getQueue();
      if (mine !== request) return;
      label.textContent = query
        ? tracks.length
          ? "Résultats"
          : "Aucun résultat."
        : tracks.length
          ? "À suivre"
          : "La file d'attente est vide.";
      list.replaceChildren(...tracks.map(query ? searchRow : queueRow));
    } catch {
      if (mine !== request) return;
      label.textContent = "Spotify est injoignable, ou tu n'es pas connecté.";
      list.replaceChildren();
    }
  }

  let typing: number | undefined;
  input.addEventListener("input", () => {
    window.clearTimeout(typing);
    typing = window.setTimeout(() => void refresh(), SEARCH_DELAY_MS);
  });

  // The queue moves on with the music.
  let shownFor: string | null = null;
  onUpdate((snap) => {
    const uri = snap.track?.uri ?? null;
    if (uri === shownFor) return;
    shownFor = uri;
    if (!overlay.hidden && !input.value.trim()) void refresh();
  });

  return {
    open() {
      const id = getSnapshot().track?.id;
      spotifyLink.href = id ? `https://open.spotify.com/track/${id}` : "https://open.spotify.com/";
      input.value = "";
      label.textContent = "";
      list.replaceChildren();
      overlay.hidden = false;
      void refresh();
    },
  };
}

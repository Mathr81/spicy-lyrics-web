// Browser shim for `src/utils/Lyrics/Applyer/Credits/ApplyIsByCommunity.tsx`.
//
// The original credits a community sync's maker and uploader, with Spicetify
// tooltips. The API asks clients to show that credit for `spicy_lyrics` syncs,
// so this renders the same markup (and so the same `.SongInfo` styling) without
// the Spicetify runtime: a plain link to each contributor's profile.
//
// `fetch.ts` maps the API's `UploadAttribution` onto the engine's
// `TTMLUploadMetadata` and `spicy_lyrics` onto `source: "spl"`.

interface Contributor {
  id?: string;
  username?: string;
  avatar?: string;
  url?: string;
}

function profileUrl(who: Contributor): string | null {
  if (typeof who.url === "string" && who.url.startsWith("https://")) return who.url;
  if (who.id) return `https://spicylyrics.org/uid/${encodeURIComponent(who.id)}`;
  return null;
}

function profileSection(type: "Maker" | "Uploader", label: string, who: Contributor): HTMLElement {
  const wrapper = document.createElement("span");
  wrapper.classList.add(type);
  const inner = document.createElement("span");

  const labelSpan = document.createElement("span");
  labelSpan.style.opacity = "0.5";
  labelSpan.textContent = `${label} `;

  const url = profileUrl(who);
  const profile = document.createElement(url ? "a" : "span");
  profile.classList.add("song-info-profile-section");
  if (url && profile instanceof HTMLAnchorElement) {
    profile.href = url;
    profile.target = "_blank";
    profile.rel = "noopener noreferrer";
    profile.style.color = "inherit";
  }
  profile.append("@");
  const name = document.createElement("span");
  name.textContent = who.username ?? "";
  profile.appendChild(name);

  if (who.avatar) {
    const avatarWrapper = document.createElement("span");
    const img = document.createElement("img");
    img.src = who.avatar;
    img.alt = `${who.username}'s avatar`;
    img.onerror = () => {
      img.style.display = "none";
    };
    avatarWrapper.appendChild(img);
    profile.appendChild(avatarWrapper);
  }

  inner.append(labelSpan, profile);
  wrapper.appendChild(inner);
  return wrapper;
}

export function ApplyIsByCommunity(data: any, container: HTMLElement): void {
  if (!container || data?.source !== "spl") return;

  const info = document.createElement("div");
  info.classList.add("SongInfo");

  const intro = document.createElement("span");
  intro.style.opacity = "0.5";
  intro.textContent = "These lyrics have been provided by our community";
  info.appendChild(intro);

  const maker: Contributor | undefined = data.TTMLUploadMetadata?.Maker;
  const uploader: Contributor | undefined = data.TTMLUploadMetadata?.Uploader;
  if (maker?.username) info.appendChild(profileSection("Maker", "Made by", maker));
  if (uploader?.username) {
    info.appendChild(profileSection("Uploader", maker?.username ? "Uploaded by" : "Made by", uploader));
  }

  container.appendChild(info);
}

export function CleanUpIsByCommunity(): void {
  /* nothing to tear down: no listeners or tooltips are attached */
}

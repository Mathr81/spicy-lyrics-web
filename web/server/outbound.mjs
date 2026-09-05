// Route the proxy's own outgoing requests through an upstream proxy.
//
// The Spicy Lyrics proxy makes two kinds of outbound call — the lyrics API and
// Spotify's token endpoints — and both are plain `fetch()` inside worker.js.
// Node's global fetch has no proxy support that reaches SOCKS5, so when a proxy
// is configured we swap `globalThis.fetch` for one that dials through it.
//
// How it works: rather than writing an HTTP client (and its chunked-encoding,
// keep-alive and redirect handling) by hand, we only take over *connecting*.
// A custom `http.Agent.createConnection` performs the SOCKS5 handshake or the
// HTTP CONNECT exchange and hands the resulting socket back; `node:http(s)`
// then speaks HTTP over it exactly as it normally would, TLS included. That
// keeps the amount of protocol code here down to the two handshakes.
//
// Supported: socks5:// and socks5h:// (identical here — the hostname is always
// resolved by the proxy, never locally, which is what you want for a tunnel),
// and http:// / https:// CONNECT proxies. Credentials as user:pass@host.
//
// No dependencies; net/tls/http/https are all built in.

import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";

const CONNECT_TIMEOUT_MS = 15000;

export function parseProxyUrl(raw) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw.includes("://") ? raw : `socks5://${raw}`);
  } catch {
    throw new Error(`PROXY_URL is not a valid URL: ${raw}`);
  }
  const scheme = u.protocol.replace(":", "").toLowerCase();
  const kind =
    scheme === "socks5" || scheme === "socks5h" || scheme === "socks"
      ? "socks5"
      : scheme === "http" || scheme === "https"
        ? "connect"
        : null;
  if (!kind) {
    throw new Error(
      `Unsupported proxy scheme "${scheme}" — use socks5://, socks5h://, http:// or https://`
    );
  }
  return {
    kind,
    tls: scheme === "https",
    host: u.hostname,
    port: Number(u.port) || (kind === "socks5" ? 1080 : 8080),
    username: decodeURIComponent(u.username || "") || null,
    password: decodeURIComponent(u.password || "") || null,
    // For logs: never carries the password.
    label: `${scheme}://${u.username ? u.username + "@" : ""}${u.hostname}:${u.port || (kind === "socks5" ? 1080 : 8080)}`,
  };
}

// Read exactly `n` bytes, without ever switching the socket to flowing mode.
//
// This is the subtle part. Attaching a `data` handler puts the socket in flowing
// mode, and anything arriving between two such reads — handler removed, nothing
// consuming — is dropped. Calling `pause()` to avoid that is worse: a stream
// that was *explicitly* paused is not resumed by a later `data` listener, so the
// socket we hand to the HTTP client never delivers a byte and the request hangs.
//
// `socket.read(n)` in paused mode avoids both: it returns null until n bytes are
// buffered, and whatever we over-read stays in the socket's own buffer, waiting
// for the HTTP client to resume it.
function readExactly(socket, n) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const chunk = socket.read(n);
      if (chunk === null) return;
      cleanup();
      resolve(chunk);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onEnd = () => onError(new Error("proxy closed the connection mid-handshake"));
    const cleanup = () => {
      socket.removeListener("readable", attempt);
      socket.removeListener("error", onError);
      socket.removeListener("end", onEnd);
    };
    socket.on("readable", attempt);
    socket.on("error", onError);
    socket.on("end", onEnd);
    attempt();
  });
}

function rawConnect(proxy) {
  return new Promise((resolve, reject) => {
    const socket = proxy.tls
      ? tls.connect({ host: proxy.host, port: proxy.port, servername: proxy.host })
      : net.connect({ host: proxy.host, port: proxy.port });
    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      socket.destroy(new Error(`timed out connecting to proxy ${proxy.label}`))
    );
    socket.once(proxy.tls ? "secureConnect" : "connect", () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

// RFC 1928 (CONNECT) + RFC 1929 (username/password auth).
const SOCKS_REPLY = {
  1: "general SOCKS server failure",
  2: "connection not allowed by ruleset",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

async function socks5Connect(proxy, host, port) {
  const socket = await rawConnect(proxy);
  try {
    const methods = proxy.username ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));

    const greeting = await readExactly(socket, 2);
    if (greeting[0] !== 0x05) throw new Error("proxy is not SOCKS5");
    if (greeting[1] === 0xff) throw new Error("proxy rejected every auth method offered");

    if (greeting[1] === 0x02) {
      if (!proxy.username) throw new Error("proxy demands credentials but none were given");
      const u = Buffer.from(proxy.username, "utf8");
      const p = Buffer.from(proxy.password || "", "utf8");
      socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const auth = await readExactly(socket, 2);
      if (auth[1] !== 0x00) throw new Error("proxy rejected the credentials");
    } else if (greeting[1] !== 0x00) {
      throw new Error(`proxy chose unsupported auth method 0x${greeting[1].toString(16)}`);
    }

    // Always send the hostname (ATYP 0x03) and let the proxy resolve it: DNS
    // then travels through the tunnel too, which is the "socks5h" behaviour and
    // the only one that makes sense for a proxy meant to change your exit path.
    const name = Buffer.from(host, "utf8");
    if (name.length > 255) throw new Error("hostname too long for SOCKS5");
    const req = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
      name,
      Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    ]);
    socket.write(req);

    const head = await readExactly(socket, 4);
    if (head[1] !== 0x00) {
      throw new Error(`SOCKS5 CONNECT failed: ${SOCKS_REPLY[head[1]] || `code ${head[1]}`}`);
    }
    // Consume the bound address so the socket starts clean at the payload.
    const atyp = head[3];
    if (atyp === 0x01) await readExactly(socket, 4 + 2);
    else if (atyp === 0x04) await readExactly(socket, 16 + 2);
    else if (atyp === 0x03) {
      const len = await readExactly(socket, 1);
      await readExactly(socket, len[0] + 2);
    } else throw new Error(`unexpected SOCKS5 address type ${atyp}`);

    return socket;
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

async function httpConnect(proxy, host, port) {
  const socket = await rawConnect(proxy);
  try {
    const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
    if (proxy.username) {
      const creds = Buffer.from(`${proxy.username}:${proxy.password || ""}`).toString("base64");
      lines.push(`Proxy-Authorization: Basic ${creds}`);
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");

    // Read headers one byte at a time — cheap, and it cannot swallow any of the
    // tunnelled payload that follows the blank line.
    let head = Buffer.alloc(0);
    while (!head.includes("\r\n\r\n")) {
      head = Buffer.concat([head, await readExactly(socket, 1)]);
      if (head.length > 8192) throw new Error("proxy sent an oversized CONNECT response");
    }
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.toString("latin1"))?.[1]);
    if (status !== 200) throw new Error(`proxy refused CONNECT with status ${status || "?"}`);
    return socket;
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

const dial = (proxy, host, port) =>
  proxy.kind === "socks5" ? socks5Connect(proxy, host, port) : httpConnect(proxy, host, port);

// An Agent that only overrides how the connection is obtained. Node's own HTTP
// client does everything else, so redirects aside we inherit its parsing.
function makeAgent(proxy, secure) {
  const Base = secure ? https.Agent : http.Agent;
  return new (class extends Base {
    createConnection(options, callback) {
      const host = options.host;
      const port = Number(options.port) || (secure ? 443 : 80);
      dial(proxy, host, port).then((socket) => {
        // Between here and the HTTP client attaching its own handlers, an
        // 'error' on the socket has no listener — which in Node is an uncaught
        // exception, not a failed request. Hold one until handover.
        const guard = (err) => callback(err);
        socket.once("error", guard);
        const release = () => socket.removeListener("error", guard);

        if (!secure) {
          release();
          return callback(null, socket);
        }
        const tlsSocket = tls.connect({
          socket,
          servername: options.servername || host,
          ALPNProtocols: ["http/1.1"],
        });
        const tlsGuard = (err) => callback(err);
        tlsSocket.once("error", tlsGuard);
        tlsSocket.once("secureConnect", () => {
          release();
          tlsSocket.removeListener("error", tlsGuard);
          callback(null, tlsSocket);
        });
      }, callback);
    }
  })({ keepAlive: false, maxSockets: 16 });
}

const MAX_REDIRECTS = 5;

function once(url, { method, headers, body, agent, secure, signal }) {
  return new Promise((resolve, reject) => {
    const mod = secure ? https : http;
    const req = mod.request(
      url,
      { method, headers, agent },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (signal) {
      if (signal.aborted) return req.destroy(abortError());
      signal.addEventListener("abort", () => req.destroy(abortError()), { once: true });
    }
    if (body) req.write(body);
    req.end();
  });
}

function abortError() {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

async function toBodyBuffer(body) {
  if (body == null) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  // URLSearchParams, Blob, streams… — let Request normalise it for us.
  return Buffer.from(await new Request("https://x/", { method: "POST", body }).arrayBuffer());
}

/**
 * Replace `globalThis.fetch` with one that dials through `proxy`.
 * Returns the previous fetch so a caller can restore it.
 */
export function installProxyFetch(proxy, log = () => {}) {
  const agents = { http: makeAgent(proxy, false), https: makeAgent(proxy, true) };
  const previous = globalThis.fetch;

  globalThis.fetch = async function proxiedFetch(input, init = {}) {
    const request = input instanceof Request && !init.body ? input : null;
    const url = new URL(request ? request.url : typeof input === "string" ? input : input.url);
    const method = (init.method || request?.method || "GET").toUpperCase();

    const headers = new Headers(init.headers || request?.headers || undefined);
    // Node does not decompress for us here, and these bodies are small, so ask
    // for none rather than carrying a decompression path.
    headers.set("accept-encoding", "identity");
    if (!headers.has("host")) headers.set("host", url.host);

    const body = await toBodyBuffer(init.body ?? (request ? await request.arrayBuffer() : null));
    if (body && !headers.has("content-length")) headers.set("content-length", String(body.length));

    let target = url;
    for (let hop = 0; ; hop++) {
      const secure = target.protocol === "https:";
      const res = await once(target, {
        method: hop === 0 ? method : method === "POST" ? "GET" : method,
        headers: Object.fromEntries(headers),
        body: hop === 0 ? body : null,
        agent: secure ? agents.https : agents.http,
        secure,
        signal: init.signal ?? request?.signal,
      });

      const location = res.headers.location;
      if (location && res.status >= 300 && res.status < 400 && hop < MAX_REDIRECTS) {
        target = new URL(location, target);
        headers.set("host", target.host);
        continue;
      }

      const outHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        for (const one of Array.isArray(v) ? v : [v]) {
          if (v !== undefined) outHeaders.append(k, one);
        }
      }
      // 204/205/304 must not carry a body, and Response throws if given one.
      const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
      return new Response(nullBody ? null : res.body, {
        status: res.status,
        headers: outHeaders,
      });
    }
  };

  log(`outbound requests go through ${proxy.label}`);
  return previous;
}

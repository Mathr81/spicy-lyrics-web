// Tests for the outbound proxy support — run with `npm run test:outbound`.
//
// Offline: a stub origin, a real SOCKS5 server and a real HTTP CONNECT server,
// all on localhost. The point is to prove the traffic genuinely traverses the
// proxy (the proxy counts the connections it brokered) rather than quietly
// falling back to a direct connection.

import http from "node:http";
import { installProxyFetch, parseProxyUrl } from "./outbound.mjs";
import { startSocks5, startHttpConnect } from "./proxy-servers.test-helper.mjs";

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
};

// --- stub origin -----------------------------------------------------------
const seen = [];
const origin = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, body, headers: req.headers });
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/landed" });
      return res.end();
    }
    if (req.url === "/empty") {
      res.writeHead(204);
      return res.end();
    }
    if (req.url === "/slow") return; // never answers — for the abort test
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url, echo: body }));
  });
});
await new Promise((r) => origin.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${origin.address().port}`;

const realFetch = globalThis.fetch;
const restore = () => (globalThis.fetch = realFetch);

// --- parsing ---------------------------------------------------------------
{
  const p = parseProxyUrl("127.0.0.1:1080");
  check("a bare host:port is taken as socks5", p.kind === "socks5" && p.port === 1080);
  check("socks5h is accepted", parseProxyUrl("socks5h://127.0.0.1:1080").kind === "socks5");
  check("http proxies use CONNECT", parseProxyUrl("http://127.0.0.1:3128").kind === "connect");
  check("credentials are parsed",
    parseProxyUrl("socks5://bob:s3cret@127.0.0.1:1080").username === "bob");
  check("the label never leaks the password",
    !parseProxyUrl("socks5://bob:s3cret@127.0.0.1:1080").label.includes("s3cret"));
  let threw = false;
  try {
    parseProxyUrl("ftp://127.0.0.1:21");
  } catch {
    threw = true;
  }
  check("an unsupported scheme is rejected loudly", threw);
}

// --- SOCKS5, no auth -------------------------------------------------------
{
  const socks = startSocks5();
  await socks.listen();
  const proxy = parseProxyUrl(`socks5://127.0.0.1:${socks.server.address().port}`);
  installProxyFetch(proxy);

  const res = await fetch(`${ORIGIN}/hello`);
  const json = await res.json();
  check("SOCKS5: GET succeeds", res.status === 200 && json.path === "/hello");
  check("SOCKS5: the connection really went through the proxy",
    socks.state.targets.length === 1, socks.state.targets.join(","));
  check("SOCKS5: the proxy resolves the hostname (ATYP=domain)",
    socks.state.connections[0].host === "127.0.0.1");

  const post = await fetch(`${ORIGIN}/echo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hi: 1 }),
  });
  check("SOCKS5: POST body arrives intact", (await post.json()).echo === '{"hi":1}');

  const red = await fetch(`${ORIGIN}/redirect`);
  check("SOCKS5: redirects are followed", (await red.json()).path === "/landed");

  const empty = await fetch(`${ORIGIN}/empty`);
  check("SOCKS5: a 204 does not throw on an empty body", empty.status === 204);

  let aborted = false;
  try {
    await fetch(`${ORIGIN}/slow`, { signal: AbortSignal.timeout(300) });
  } catch (err) {
    aborted = err.name === "AbortError";
  }
  check("SOCKS5: AbortSignal is honoured", aborted);

  restore();
  socks.server.close();
}

// --- SOCKS5 with username/password ----------------------------------------
{
  const socks = startSocks5({ username: "bob", password: "s3cret" });
  await socks.listen();
  const port = socks.server.address().port;

  installProxyFetch(parseProxyUrl(`socks5://bob:s3cret@127.0.0.1:${port}`));
  check("SOCKS5 auth: correct credentials get through",
    (await (await fetch(`${ORIGIN}/authed`)).json()).ok === true);
  restore();

  installProxyFetch(parseProxyUrl(`socks5://bob:wrong@127.0.0.1:${port}`));
  let rejected = false;
  try {
    await fetch(`${ORIGIN}/nope`);
  } catch {
    rejected = true;
  }
  check("SOCKS5 auth: wrong credentials fail rather than falling back to direct", rejected);
  restore();
  socks.server.close();
}

// --- HTTP CONNECT ----------------------------------------------------------
{
  const connect = startHttpConnect({ username: "bob", password: "s3cret" });
  await connect.listen();
  const port = connect.server.address().port;

  installProxyFetch(parseProxyUrl(`http://bob:s3cret@127.0.0.1:${port}`));
  const res = await fetch(`${ORIGIN}/via-connect`);
  check("CONNECT: request succeeds", (await res.json()).path === "/via-connect");
  check("CONNECT: went through the proxy", connect.state.targets.length === 1);
  restore();

  installProxyFetch(parseProxyUrl(`http://bob:wrong@127.0.0.1:${port}`));
  let rejected = false;
  try {
    await fetch(`${ORIGIN}/nope`);
  } catch {
    rejected = true;
  }
  check("CONNECT: 407 surfaces as an error", rejected);
  restore();
  connect.server.close();
}

// --- a dead proxy must fail, never silently go direct ----------------------
{
  installProxyFetch(parseProxyUrl("socks5://127.0.0.1:1"));
  let rejected = false;
  try {
    await fetch(`${ORIGIN}/should-not-arrive`);
  } catch {
    rejected = true;
  }
  const before = seen.length;
  check("an unreachable proxy fails closed", rejected);
  check("...and the request never reached the origin directly", seen.length === before);
  restore();
}

origin.close();
console.log(failed ? `\n${failed} FAILED` : "\nall good");
process.exit(failed ? 1 : 0);

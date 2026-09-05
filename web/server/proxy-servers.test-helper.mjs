// Minimal SOCKS5 and HTTP CONNECT servers, for the outbound-proxy tests.
// Just enough of each protocol to accept a CONNECT and pipe bytes, plus a
// counter so a test can assert traffic really went through here.

import net from "node:net";

export function startSocks5({ username, password } = {}) {
  const state = { connections: [], targets: [] };
  const server = net.createServer((client) => {
    let stage = "greeting";
    let buf = Buffer.alloc(0);

    client.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (stage === "greeting") {
          if (buf.length < 2) return;
          const n = buf[1];
          if (buf.length < 2 + n) return;
          const methods = [...buf.subarray(2, 2 + n)];
          buf = buf.subarray(2 + n);
          if (username) {
            if (!methods.includes(0x02)) return client.end(Buffer.from([0x05, 0xff]));
            client.write(Buffer.from([0x05, 0x02]));
            stage = "auth";
          } else {
            client.write(Buffer.from([0x05, 0x00]));
            stage = "request";
          }
          continue;
        }
        if (stage === "auth") {
          if (buf.length < 2) return;
          const ulen = buf[1];
          if (buf.length < 2 + ulen + 1) return;
          const plen = buf[2 + ulen];
          if (buf.length < 3 + ulen + plen) return;
          const u = buf.subarray(2, 2 + ulen).toString();
          const p = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
          buf = buf.subarray(3 + ulen + plen);
          const ok = u === username && p === password;
          client.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          if (!ok) return client.end();
          stage = "request";
          continue;
        }
        if (stage === "request") {
          if (buf.length < 5) return;
          if (buf[3] !== 0x03) return client.end(Buffer.from([0x05, 0x08, 0, 1, 0, 0, 0, 0, 0, 0]));
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;
          const host = buf.subarray(5, 5 + len).toString();
          const port = buf.readUInt16BE(5 + len);
          buf = buf.subarray(5 + len + 2);
          state.connections.push({ host, port });
          state.targets.push(`${host}:${port}`);

          const upstream = net.connect({ host, port }, () => {
            // Success, bound address 0.0.0.0:0 — clients must skip it.
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            if (buf.length) upstream.write(buf);
            buf = Buffer.alloc(0);
            client.pipe(upstream);
            upstream.pipe(client);
          });
          upstream.on("error", () => client.destroy());
          stage = "piping";
          return;
        }
        return;
      }
    });
    client.on("error", () => {});
  });
  return { server, state, listen: () => new Promise((r) => server.listen(0, "127.0.0.1", r)) };
}

export function startHttpConnect({ username, password } = {}) {
  const state = { connections: [], targets: [] };
  const server = net.createServer((client) => {
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.removeListener("data", onData);
      const rest = head.subarray(end + 4);
      const text = head.subarray(0, end).toString("latin1");
      const [, hostPort] = /^CONNECT (\S+) HTTP\/1\.[01]/.exec(text) || [];
      if (!hostPort) return client.end("HTTP/1.1 400 Bad Request\r\n\r\n");

      if (username) {
        const want = Buffer.from(`${username}:${password || ""}`).toString("base64");
        if (!new RegExp(`Proxy-Authorization: Basic ${want}`, "i").test(text)) {
          return client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        }
      }

      const [host, port] = [hostPort.replace(/:\d+$/, ""), Number(hostPort.split(":").pop())];
      state.connections.push({ host, port });
      state.targets.push(`${host}:${port}`);
      const upstream = net.connect({ host, port }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
    client.on("error", () => {});
  });
  return { server, state, listen: () => new Promise((r) => server.listen(0, "127.0.0.1", r)) };
}

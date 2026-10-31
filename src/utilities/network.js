import { networkInterfaces } from 'node:os';

/** IPv4 addresses of this machine's network cards: `{ name, address }`, real cards first, loopback last. */
export function listInterfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' || a.family === 4) out.push({ name, address: a.address, internal: a.internal });
    }
  }
  return out.sort((x, y) => Number(x.internal) - Number(y.internal) || x.name.localeCompare(y.name));
}

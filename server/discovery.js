// Finds ProPresenter instances on the network.
//
// ProPresenter's network port is user-chosen (often a random 5-digit port) and
// recent versions don't reliably advertise over Bonjour, so discovery combines:
//   1. mDNS/DNS-SD browse for any ProPresenter-looking service types
//   2. a subnet sweep of likely ports (configured + previously seen)
//   3. a full port sweep of one host on demand ("deep scan"), run automatically
//      for localhost at startup
// Every hit is confirmed with GET /version, which identifies ProPresenter.
'use strict';
const net = require('net');
const os = require('os');
const http = require('http');
const dgram = require('dgram');
const EventEmitter = require('events');

function probeVersion(host, port, timeout = 1200) {
  return new Promise(resolve => {
    const req = http.get({ host, port, path: '/version', timeout }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
      res.on('end', () => {
        try {
          const v = JSON.parse(body);
          if (v && /propresenter/i.test(`${v.name} ${v.host_description}`)) return resolve(v);
        } catch { /* not ProPresenter */ }
        resolve(null);
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function portOpen(host, port, timeout) {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = ok => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  });
  await Promise.all(workers);
}

function ipToInt(ip) { return ip.split('.').reduce((a, o) => (a << 8) + +o, 0) >>> 0; }
function intToIp(n) { return [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.'); }

// Hosts on each local IPv4 subnet (capped at a /22 so a big corporate LAN doesn't take forever).
function subnetHosts() {
  const hosts = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = ipToInt(a.address);
      let mask = ipToInt(a.netmask);
      if ((~mask >>> 0) > 1023) mask = 0xfffffc00; // /22
      const base = (ip & mask) >>> 0, size = (~mask >>> 0);
      for (let h = 1; h < size; h++) hosts.add(intToIp(base + h));
    }
  }
  return [...hosts];
}

function localAddresses() {
  const out = new Set(['127.0.0.1', 'localhost']);
  for (const addrs of Object.values(os.networkInterfaces())) for (const a of addrs || []) if (a.family === 'IPv4') out.add(a.address);
  return out;
}

// ---- minimal mDNS (DNS-SD) client ------------------------------------------

function encodeName(name) {
  const parts = name.replace(/\.$/, '').split('.');
  return Buffer.concat([...parts.map(p => Buffer.concat([Buffer.from([Buffer.byteLength(p)]), Buffer.from(p)])), Buffer.from([0])]);
}

function query(names, type = 12) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(names.length, 4);
  const qs = names.map(n => Buffer.concat([encodeName(n), Buffer.from([0, type, 0x80, 1])])); // QU bit set
  return Buffer.concat([header, ...qs]);
}

function readName(buf, pos) {
  const labels = [];
  let jumped = false, end = pos, guard = 0;
  while (guard++ < 128) {
    const len = buf[pos];
    if (len === undefined) break;
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      jumped = true;
      continue;
    }
    if (len === 0) { if (!jumped) end = pos + 1; break; }
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += len + 1;
  }
  return [labels.join('.'), end];
}

function parseResponse(buf) {
  const records = [];
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let pos = 12;
  for (let i = 0; i < qd; i++) { [, pos] = readName(buf, pos); pos += 4; }
  for (let i = 0; i < total && pos < buf.length; i++) {
    let name;
    [name, pos] = readName(buf, pos);
    const type = buf.readUInt16BE(pos), len = buf.readUInt16BE(pos + 8);
    const rd = pos + 10;
    const r = { name, type };
    if (type === 12) r.ptr = readName(buf, rd)[0];
    else if (type === 33) { r.port = buf.readUInt16BE(rd + 4); r.target = readName(buf, rd + 6)[0]; }
    else if (type === 1) r.a = [...buf.subarray(rd, rd + 4)].join('.');
    records.push(r);
    pos = rd + len;
  }
  return records;
}

const KNOWN_TYPES = ['_pro7proremote._tcp.local', '_pro7stagedsply._tcp.local', '_propresenter._tcp.local', '_pro7remote._tcp.local', '_pro7._tcp.local'];

function mdnsBrowse(ms = 2500) {
  return new Promise(resolve => {
    const found = new Map(); // "ip:port" -> { host, port, service }
    const records = [];
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { return resolve([]); }
    const finish = () => {
      try { sock.close(); } catch { /* closed */ }
      const aByName = {};
      records.filter(r => r.type === 1).forEach(r => { aByName[r.name] = r.a; });
      for (const s of records.filter(r => r.type === 33)) {
        const host = aByName[s.target] || s.rinfo;
        if (host) found.set(`${host}:${s.port}`, { host, port: s.port, service: s.name });
      }
      resolve([...found.values()]);
    };
    sock.on('error', finish);
    sock.on('message', (msg, rinfo) => {
      try {
        const rs = parseResponse(msg).map(r => ({ ...r, rinfo: rinfo.address }));
        records.push(...rs);
        // Follow up on any ProPresenter-ish service type we learn about.
        const types = rs.filter(r => r.type === 12 && r.name === '_services._dns-sd._udp.local' && /pro/i.test(r.ptr)).map(r => r.ptr);
        if (types.length) sock.send(query(types), 5353, '224.0.0.251');
        const instances = rs.filter(r => r.type === 12 && /pro/i.test(r.name) && r.name !== '_services._dns-sd._udp.local').map(r => r.ptr);
        if (instances.length) sock.send(query(instances, 33), 5353, '224.0.0.251');
      } catch { /* malformed packet */ }
    });
    sock.bind(0, () => {
      try {
        sock.send(query(['_services._dns-sd._udp.local', ...KNOWN_TYPES]), 5353, '224.0.0.251');
      } catch { /* no multicast route */ }
      setTimeout(finish, ms);
    });
  });
}

// ---- discovery service ------------------------------------------------------

class Discovery extends EventEmitter {
  constructor(getConfig) {
    super();
    this.getConfig = getConfig;
    this.instances = new Map(); // key "host:port"
    this.scanning = false;
    this.progress = null;
    this.seenPorts = new Set();
  }

  list() {
    return [...this.instances.values()].sort((a, b) => (a.local === b.local ? a.host.localeCompare(b.host) : a.local ? -1 : 1));
  }

  async add(host, port, source) {
    // The same local instance answers on localhost and on each LAN address; keep one.
    const local = localAddresses().has(host);
    const key = `${local ? '127.0.0.1' : host}:${port}`;
    const v = await probeVersion(host, port);
    const known = this.instances.get(key);
    if (!v) {
      if (known && known.online) { known.online = false; this.emit('change'); }
      return null;
    }
    this.seenPorts.add(port);
    const inst = {
      host: local ? '127.0.0.1' : host, port, name: v.host_description || v.name, platform: v.platform,
      os: v.os_version, api: v.api_version, source: known ? known.source : source, local, online: true, lastSeen: Date.now(),
    };
    const changed = !known || !known.online;
    this.instances.set(key, inst);
    if (changed) this.emit('change');
    return inst;
  }

  // Quick pass: re-check known instances, manual hosts, mDNS, and localhost on likely ports.
  async quick() {
    const cfg = this.getConfig();
    const ports = [...new Set([...cfg.scanPorts, ...this.seenPorts])];
    const jobs = [];
    for (const i of this.instances.values()) jobs.push([i.host, i.port, i.source]);
    for (const m of cfg.manualHosts) jobs.push([m.host, +m.port, 'manual']);
    if (cfg.connection) jobs.push([cfg.connection.host, +cfg.connection.port, 'saved']);
    for (const p of ports) jobs.push(['127.0.0.1', p, 'scan']);
    const mdns = await mdnsBrowse();
    for (const m of mdns) jobs.push([m.host, m.port, 'mdns']);
    await pool(jobs, 32, ([h, p, s]) => this.add(h, p, s));
  }

  // Sweep every host on the local subnet(s) for the likely ports.
  async sweep() {
    const cfg = this.getConfig();
    if (!cfg.scanSubnets) return;
    const ports = [...new Set([...cfg.scanPorts, ...this.seenPorts])];
    const hosts = subnetHosts();
    const targets = hosts.flatMap(h => ports.map(p => [h, p]));
    let done = 0;
    await pool(targets, 256, async ([h, p]) => {
      if (await portOpen(h, p, 350)) await this.add(h, p, 'scan');
      if (++done % 200 === 0) this.setProgress(`Sweeping subnet… ${Math.round((done / targets.length) * 100)}%`);
    });
  }

  // Try every TCP port on one host. ~64k connects: seconds on localhost, ~30s on a LAN.
  async deepScan(host) {
    const ports = [];
    for (let p = 1024; p <= 65535; p++) ports.push(p);
    const local = localAddresses().has(host);
    let done = 0;
    const open = [];
    await pool(ports, local ? 800 : 600, async p => {
      if (await portOpen(host, p, local ? 250 : 500)) open.push(p);
      if (++done % 4000 === 0) this.setProgress(`Deep scan ${host}… ${Math.round((done / ports.length) * 100)}%`);
    });
    await pool(open, 16, p => this.add(host, p, 'deep-scan'));
  }

  setProgress(text) { this.progress = text; this.emit('change'); }

  async run({ deep = null, full = true } = {}) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      this.setProgress('Looking for ProPresenter…');
      await this.quick();
      if (deep) await this.deepScan(deep);
      if (full) await this.sweep();
    } catch (e) {
      console.error('[discovery]', e.message);
    } finally {
      this.scanning = false;
      this.setProgress(null);
    }
  }
}

module.exports = { Discovery, probeVersion };

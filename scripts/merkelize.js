#!/usr/bin/env node

'use strict';

const assert = require('bsert');
const fs = require('bfile');
const Path = require('path');
const bio = require('bufio');
const pgp = require('bcrypto/lib/pgp');
const ssh = require('bcrypto/lib/ssh');
const base64 = require('bcrypto/lib/internal/base64');
const pem = require('bcrypto/lib/encoding/pem');
const blake2b = require('bcrypto/lib/blake2b');
const sha256 = require('bcrypto/lib/sha256');
const merkle = require('bcrypto/lib/mrkl');
const random = require('bcrypto/lib/random');
const AirdropKey = require('../lib/key');
const {PGPMessage, PGPPublicKey} = pgp;
const {SSHPublicKey} = ssh;

/*
 * Constants
 */

const TREE_FILE = Path.resolve(__dirname, '..', 'build', 'tree.bin');
const TREE_JSON = Path.resolve(__dirname, '..', 'etc', 'tree.json');
const NONCE_DIR = Path.resolve(__dirname, '..', 'build', 'nonces');
const MAX_AIRDROP = 0.952e9 * 1e6;

/*
 * Main
 */

async function main() {
  const hasher = new Hasher();
  const [total, checksum] = await hasher.hash();
  const leaves = hasher.leaves;

  console.log(
    'Wrote merkle tree with %d keys and %d leaves.',
    total,
    leaves.length
  );

  const root = hasher.hashTree();
  const maxAirdrop = MAX_AIRDROP - hasher.faucet;
  const reward = Math.floor(maxAirdrop / hasher.participants);

  console.log('Checksum: %s', checksum.toString('hex'));
  console.log('Tree Root: %s', root.toString('hex'));
  console.log('Leaves: %d', hasher.leaves.length);
  console.log('Keys: %d', total);
  console.log('Max Keys: %d', hasher.maxKeys);
  console.log('Depth: %d', getDepth(hasher.leaves.length));
  console.log('Subdepth: %d', getDepth(hasher.maxKeys));
  console.log('Reward: %d', reward);
  console.log('Participants: %d', hasher.participants);
  console.log('Faucet Total: %d', hasher.faucet);
  console.log('Sponsors: %d', hasher.sponsors);
  console.log('Creators: %d', hasher.creators);
  console.log('External Total: %d', hasher.external);

  assert(((hasher.participants * reward) + hasher.faucet) <= MAX_AIRDROP);
  assert(hasher.external === 204000000e6);

  const json = JSON.stringify({
    checksum: checksum.toString('hex'),
    root: root.toString('hex'),
    leaves: leaves.length,
    keys: total,
    maxKeys: hasher.maxKeys,
    depth: getDepth(leaves.length),
    subdepth: getDepth(hasher.maxKeys),
    reward,
    checksums: hasher.checksums.map(h => h.toString('hex'))
  }, null, 2);

  return fs.writeFile(TREE_JSON, json + '\n');
}

/*
 * Hasher
 */

class Hasher {
  constructor() {
    this.leaves = [];
    this.buckets = [];
    this.checksums = [];
    this.existing = new Set();
    this.maxKeys = 1;
    this.participants = 0;
    this.faucet = 0;
    this.sponsors = 0;
    this.creators = 0;
    this.external = 0;

    for (let i = 0; i < 256; i++)
      this.buckets.push([]);
  }

  pushNonce(key) {
    assert(key instanceof AirdropKey);

    const bucket = key.hash()[0];
    const [nonce, newKey] = key.generate();

    key.applyNonce(nonce);

    const ct = key.encrypt(nonce);

    this.buckets[bucket].push(ct);

    return newKey;
  }

  async hash() {
    await this.readExisting();
    await this.hashGithub();
    await this.hashStrongset();
    await this.hashFaucet();
    await this.hashSponsors();
    await this.hashCreators();
    await this.writeNonces();

    return this.writeTree();
  }

  async readExisting() {
    const faucet = await readJSON('..', 'data', 'faucet.json');

    // Format:
    // {
    //   github: String|null,
    //   pgp: String|null,
    //   address: String,
    //   value: Number
    // }
    for (const {github, pgp} of faucet) {
      if (github)
        this.existing.add(github.toLowerCase());

      if (pgp)
        this.existing.add(pgp.toLowerCase());
    }
  }

  async hashGithub() {
    const sshKeys = await readJSON('..', 'data', 'github-ssh.json');
    const pgpKeys = await readJSON('..', 'data', 'github-pgp.json');

    assert(Array.isArray(sshKeys));
    assert(Array.isArray(pgpKeys));
    assert.strictEqual(sshKeys.length, pgpKeys.length);

    let validKeys = 0;
    let validUsers = 0;
    let invalidKeys = 0;
    let invalidUsers = 0;

    for (let i = 0; i < sshKeys.length; i++) {
      const [id, name, ssh] = sshKeys[i];
      const [id2, name2, pgp] = pgpKeys[i];

      assert(Number.isSafeInteger(id) && id >= 0);
      assert(Number.isSafeInteger(id2) && id2 >= 0);
      assert(typeof name === 'string');
      assert(typeof name2 === 'string');
      assert(Array.isArray(ssh));
      assert(Array.isArray(pgp));
      assert.strictEqual(id, id2);
      assert.strictEqual(name, name2);

      if (this.existing.has(name.toLowerCase())) {
        console.log('Already have github user: %s', name);
        continue;
      }

      const totalKeys = ssh.length + pgp.length;

      if (totalKeys === 0)
        continue;

      const hashes = [];

      let invalid = 0;

      invalid += this.parseSSHKeys(name, ssh, hashes);
      invalid += this.parsePGPKeys(name, pgp, hashes);

      invalidKeys += invalid;

      assert(invalid <= totalKeys);

      if (invalid === totalKeys) {
        assert(hashes.length === 0);
        invalidUsers += 1;
        continue;
      }

      assert(hashes.length > 0);
      assert(hashes.length <= 255);

      if (hashes.length > this.maxKeys)
        this.maxKeys = hashes.length;

      validKeys += hashes.length;
      validUsers += 1;

      this.leaves.push(hashes.sort(compare));
      this.participants += 1;
    }

    console.log('Valid github users: %d', validUsers);
    console.log('Valid github keys: %d', validKeys);
    console.log('Invalid github users: %d', invalidUsers);
    console.log('Invalid github keys: %d', invalidKeys);
  }

  parseSSHKeys(name, keys, hashes) {
    assert(typeof name === 'string');
    assert(Array.isArray(keys));
    assert(Array.isArray(hashes));

    let invalid = 0;

    // [id, name, [[k1-id, k1-base64],...]]
    for (const [id, str] of keys) {
      assert(Number.isSafeInteger(id) && id >= 0);
      assert(typeof str === 'string');

      const pubkey = SSHPublicKey.fromString(str);

      let key;
      try {
        key = AirdropKey.fromSSH(pubkey);
      } catch (e) {
        if (e.message === 'Unsupported algorithm.') {
          invalid += 1;
          continue;
        }
        throw e;
      }

      if (!key.validate()) {
        invalid += 1;
        continue;
      }

      const newKey = this.pushNonce(key);

      hashes.push(key.hash());

      if (newKey)
        hashes.push(newKey.hash());
    }

    return invalid;
  }

  parsePGPKeys(name, keys, hashes) {
    assert(typeof name === 'string');
    assert(Array.isArray(keys));
    assert(Array.isArray(hashes));

    let invalid = 0;

    // [id, name, [[k1-id, k1-key-id, k1-base64, [[email, verified]]],...]]
    for (const [id, keyID, str, emails] of keys) {
      assert(Number.isSafeInteger(id) && id >= 0);
      assert(typeof keyID === 'string' && keyID.length === 16);
      assert(typeof str === 'string');
      assert(Array.isArray(emails));

      let valid = false;

      for (const [email, verified] of emails) {
        assert(typeof email === 'string');
        assert((verified >>> 0) === verified);
        assert(verified === 0 || verified === 1);

        if (verified) {
          valid = true;
          break;
        }
      }

      if (!valid) {
        invalid += 1;
        continue;
      }

      const data = base64.decode(str);

      let pubkey;
      try {
        pubkey = PGPPublicKey.decode(data);
      } catch (e) {
        invalid += 1;
        continue;
      }

      const hexID = pubkey.id().toString('hex');

      if (hexID !== keyID) {
        console.log(
          'Warning: PGP Key ID %s != %s for %s! (gh)',
          hexID, keyID, name);
        invalid += 1;
        continue;
      }

      let key;
      try {
        key = AirdropKey.fromPGP(pubkey);
      } catch (e) {
        if (e.message === 'Unsupported algorithm.') {
          invalid += 1;
          continue;
        }
        throw e;
      }

      if (!key.validate()) {
        invalid += 1;
        continue;
      }

      const newKey = this.pushNonce(key);

      hashes.push(key.hash());

      if (newKey)
        hashes.push(newKey.hash());
    }

    return invalid;
  }

  async hashStrongset() {
    const str = await readText('..', 'data', 'strongset.asc');

    let valid = 0;
    let invalid = 0;

    for (const block of pem.decode(str, true)) {
      const keyID = block.headers.get('Key-ID');
      assert(keyID);

      const email = block.headers.get('Email');

      if (email && this.existing.has(email.toLowerCase())) {
        console.log('Already have strongset member: %s', email);
        continue;
      }

      const msg = PGPMessage.decode(block.data);
      assert(msg.packets.length > 0);

      const pkt = msg.packets[0];

      assert.strictEqual(pkt.type, pgp.packetTypes.PUBLIC_KEY);

      const pubkey = pkt.body;
      const hexID = pubkey.id().toString('hex');

      if (hexID !== keyID) {
        const name = block.headers.get('User-ID');
        console.log(
          'Warning: PGP Key ID %s != %s for %s! (ss)',
          hexID, keyID, name);
        invalid += 1;
        continue;
      }

      let key;
      try {
        key = AirdropKey.fromPGP(pubkey);
      } catch (e) {
        if (e.message === 'Unsupported algorithm.') {
          invalid += 1;
          continue;
        }
        throw e;
      }

      if (!key.validate()) {
        invalid += 1;
        continue;
      }

      valid += 1;

      const hashes = [];

      const newKey = this.pushNonce(key);

      hashes.push(key.hash());

      if (newKey)
        hashes.push(newKey.hash());

      this.leaves.push(hashes);
      this.participants += 1;
    }

    console.log('Valid strongset members: %d', valid);
    console.log('Invalid strongset members: %d', invalid);
  }

  async hashFaucet() {
    const faucet = await readJSON('..', 'data', 'faucet.json');

    for (const {address, value} of faucet) {
      const key = AirdropKey.fromAddress(address, value, false);

      this.leaves.push([key.hash()]);
      this.faucet += value;
    }

    console.log('Valid faucet addresses: %d', faucet.length);
  }

  async hashSponsors() {
    const sponsors = await readJSON('..', 'data', 'sponsors.json');

    for (const {address, value} of sponsors) {
      const key = AirdropKey.fromAddress(address, value, true);

      this.leaves.push([key.hash()]);
      this.sponsors += 1;
      this.external += value;
    }

    console.log('Valid sponsor addresses: %d', sponsors.length);
  }

  async hashCreators() {
    const creators = await readJSON('..', 'data', 'creators.json');

    for (const {address, value} of creators) {
      const key = AirdropKey.fromAddress(address, value, false);

      this.leaves.push([key.hash()]);
      this.creators += 1;
      this.external += value;
    }

    console.log('Valid creator addresses: %d', creators.length);
  }

  async writeNonces() {
    if (!await fs.exists(NONCE_DIR))
      await fs.mkdir(NONCE_DIR, 0o755);

    let total = 0;

    for (let i = 0; i < 256; i++) {
      const nonces = this.buckets[i];
      const path = Path.resolve(NONCE_DIR, `${pad(i)}.bin`);

      let size = 0;

      for (const ct of nonces)
        size += 2 + ct.length;

      const bw = bio.write(size);

      for (const ct of nonces) {
        bw.writeU16(ct.length);
        bw.writeBytes(ct);
      }

      const raw = bw.render();

      this.checksums.push(sha256.digest(raw));

      await fs.writeFile(path, raw);

      total += size;
    }

    console.log('Wrote buckets (size=%dmb).', total / 1024 / 1024);
  }

  async writeTree() {
    this.leaves.sort((a, b) => {
      const x = merkle.createRoot(blake2b, a);
      const y = merkle.createRoot(blake2b, b);
      return x.compare(y);
    });

    let total = 0;
    let size = 0;

    size += 4;

    for (const hashes of this.leaves) {
      size += 1;
      size += 32 * hashes.length;
      total += hashes.length;
    }

    const bw = bio.write(size);

    bw.writeU32(this.leaves.length);

    for (const hashes of this.leaves) {
      assert(hashes.length <= 255);
      bw.writeU8(hashes.length);

      for (const hash of hashes)
        bw.writeBytes(hash);
    }

    const raw = bw.render();

    await fs.writeFile(TREE_FILE, raw);

    return [total, sha256.digest(raw)];
  }

  hashTree() {
    const tree = [];

    for (const hashes of this.leaves)
      tree.push(merkle.createRoot(blake2b, hashes));

    return merkle.createRoot(blake2b, tree);
  }
}

/*
 * Helpers
 */

function compare(a, b) {
  return a.compare(b);
}

async function readText(...args) {
  const file = Path.resolve(__dirname, ...args);
  return fs.readFile(file, 'utf8');
}

async function readJSON(...args) {
  const str = await readText(...args);
  return JSON.parse(str);
}

function getDepth(size) {
  assert((size >>> 0) === size);

  let depth = 0;

  while (size > 1) {
    depth += 1;
    size = (size + 1) >>> 1;
  }

  return depth;
}

function pad(index) {
  assert((index & 0xff) === index);

  let str = index.toString(10);

  while (str.length < 3)
    str = '0' + str;

  return str;
}

/*
 * Execute
 */

main().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});

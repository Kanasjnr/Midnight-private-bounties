// Spike Q11 (and Q9) benchmark.
//
// Runs postBounty then submit in compact-runtime, checks the poster can read
// and decrypt the delivery from contract state (JubjubPoints inside map
// value structs), then times proving both circuits on a local proof server.
//
//   node bench.mjs [runs]        proof server must be on 127.0.0.1:6300

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
  rawTokenType,
  encodeRawTokenType,
} from '@midnight-ntwrk/compact-runtime';
import { proofDataIntoSerializedPreimage, createProvingPayload } from '@midnight-ntwrk/ledger-v8';
import { Contract, ledger, pureCircuits } from './managed/contract/index.js';

const PROOF_SERVER = 'http://127.0.0.1:6300';
const RUNS = Number(process.argv[2] ?? 3);
const COIN_PK = '0'.repeat(64);
const ADDRESS = sampleContractAddress();

const rand248 = () => BigInt('0x' + randomBytes(31).toString('hex'));
const pad32 = (s) => { const b = new Uint8Array(32); b.set(new TextEncoder().encode(s)); return b; };

const color = encodeRawTokenType(rawTokenType(pad32('bounty:test-token'), ADDRESS));
const freshCoin = (value) => ({ nonce: randomBytes(32), color, value });

const bountyId = randomBytes(32);
const posterSk = rand248();
const priv = { sk: randomBytes(32), m: Array.from({ length: 4 }, rand248), e: rand248() };

const contract = new Contract({
  localSecretKey: ({ privateState }) => [privateState, privateState.sk],
  answer: ({ privateState }) => [privateState, privateState.m],
  ephemeralScalar: ({ privateState }) => [privateState, privateState.e],
});

function keyMaterial(name) {
  return {
    proverKey: readFileSync(`managed/keys/${name}.prover`),
    verifierKey: readFileSync(`managed/keys/${name}.verifier`),
    ir: readFileSync(`managed/zkir/${name}.bzkir`),
  };
}

async function proveTimes(name, proofData) {
  const pd = proofData;
  const preimage = proofDataIntoSerializedPreimage(
    pd.input, pd.output, pd.publicTranscript, pd.privateTranscriptOutputs, name,
  );
  const payload = createProvingPayload(preimage, undefined, keyMaterial(name));
  const once = async () => {
    const t0 = performance.now();
    const res = await fetch(`${PROOF_SERVER}/prove`, { method: 'POST', body: payload });
    const body = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}: ${new TextDecoder().decode(body).slice(0, 300)}`);
    return { ms: performance.now() - t0, bytes: body.length };
  };
  const first = await once();
  const times = [];
  let bytes = first.bytes;
  for (let i = 0; i < RUNS; i++) { const r = await once(); times.push(r.ms); bytes = r.bytes; }
  times.sort((a, b) => a - b);
  const s = (ms) => (ms / 1000).toFixed(1) + 's';
  console.log(`${name.padEnd(11)} first=${s(first.ms)}  median=${s(times[Math.floor(times.length / 2)])}  ` +
    `min=${s(times[0])}  max=${s(times.at(-1))}  proof=${bytes}B`);
}

// Deploy (the contract has no constructor arguments).
const init = contract.initialState(createConstructorContext(priv, COIN_PK));
let ctx = createCircuitContext(ADDRESS, COIN_PK, init.currentContractState, priv);

// postBounty: reward 100, deadline an hour from now (Unix seconds, per Q7).
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
const target = pureCircuits.answerHash(priv.m);
const posterPk = pureCircuits.publicKey(posterSk);
const post = contract.circuits.postBounty(ctx, bountyId, freshCoin(100n), posterPk, target, deadline);
ctx = post.context;

// Q9: a JubjubPoint inside a map value struct, read back from state.
const stored = ledger(ctx.currentQueryContext.state).bounties.lookup(bountyId);
const pkRoundTrip = stored.posterPk.x === posterPk.x && stored.posterPk.y === posterPk.y;
console.log(`Q9 posterPk stored in Bounty struct and read back intact: ${pkRoundTrip}`);

// submit: the solver brings a fresh coin of 10.
const sub = contract.circuits.submit(ctx, bountyId, freshCoin(10n));
const state = ledger(sub.context.currentQueryContext.state);
const d = state.deliveries.lookup(bountyId);
const plain = pureCircuits.decrypt4(d.c, d.ephemeralPk, posterSk, pureCircuits.idField(bountyId));
const decrypts = plain.every((v, i) => v === priv.m[i]);
console.log(`Q9 Delivery struct (JubjubPoint + Vector) read back, poster decrypts the answer: ${decrypts}`);
console.log(`status after submit: ${state.bounties.lookup(bountyId).status} (1 = SOLVED), escrow removed: ${!state.escrows.member(bountyId)}`);

console.log(`\nproof server ${PROOF_SERVER}, ${RUNS} timed runs after one warm-up\n`);
await proveTimes('postBounty', post.proofData);
await proveTimes('submit', sub.proofData);
if (!pkRoundTrip || !decrypts) process.exit(1);

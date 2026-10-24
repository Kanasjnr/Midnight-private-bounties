// Spike Q1 benchmark: prove each circuit on a local proof server and time it.
// Also checks the decryption round trip (Q4): the poster decrypts what
// submit4 encrypted, using the contract's own pure circuits.
//
//   node bench.mjs [runs]        proof server must be on 127.0.0.1:6300

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { proofDataIntoSerializedPreimage, createProvingPayload } from '@midnight-ntwrk/ledger-v8';
import { Contract, ledger, pureCircuits } from './managed/contract/index.js';

const PROOF_SERVER = 'http://127.0.0.1:6300';
const RUNS = Number(process.argv[2] ?? 3);
const COIN_PK = '0'.repeat(64);
const BOUNTY_ID = 7n;

// Random value that fits in 248 bits: a valid Field element, and a valid
// Jubjub scalar.
const rand248 = () => BigInt('0x' + randomBytes(31).toString('hex'));

const priv = {
  m4: Array.from({ length: 4 }, rand248),
  m8: Array.from({ length: 8 }, rand248),
  e: rand248(),
  k: rand248(),
};
const posterSk = rand248();
const posterPk = pureCircuits.publicKey(posterSk);

const witnesses = {
  answer4: ({ privateState }) => [privateState, privateState.m4],
  answer8: ({ privateState }) => [privateState, privateState.m8],
  ephemeralScalar: ({ privateState }) => [privateState, privateState.e],
  symmetricKey: ({ privateState }) => [privateState, privateState.k],
};
const contract = new Contract(witnesses);

// submit8 checks a hash of 8 elements, the others a hash of 4, so it needs
// its own deployment with a different target.
function deploy(target) {
  const init = contract.initialState(
    createConstructorContext(priv, COIN_PK),
    posterPk,
    target,
    pureCircuits.answerSha(priv.m4),
    BOUNTY_ID,
  );
  return createCircuitContext(sampleContractAddress(), COIN_PK, init.currentContractState, priv);
}

function keyMaterial(name) {
  return {
    proverKey: readFileSync(`managed/keys/${name}.prover`),
    verifierKey: readFileSync(`managed/keys/${name}.verifier`),
    ir: readFileSync(`managed/zkir/${name}.bzkir`),
  };
}

async function prove(name, payload) {
  const t0 = performance.now();
  const res = await fetch(`${PROOF_SERVER}/prove`, { method: 'POST', body: payload });
  const body = new Uint8Array(await res.arrayBuffer());
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}: ${new TextDecoder().decode(body).slice(0, 300)}`);
  return { ms, bytes: body.length };
}

async function bench(name, ctx) {
  const run = contract.circuits[name](ctx);
  const pd = run.proofData;
  const preimage = proofDataIntoSerializedPreimage(
    pd.input, pd.output, pd.publicTranscript, pd.privateTranscriptOutputs, name,
  );
  const payload = createProvingPayload(preimage, undefined, keyMaterial(name));

  // First call also loads public parameters for this k, so time it separately.
  const first = await prove(name, payload);
  const times = [];
  let proofBytes = first.bytes;
  for (let i = 0; i < RUNS; i++) {
    const r = await prove(name, payload);
    times.push(r.ms);
    proofBytes = r.bytes;
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(
    `${name.padEnd(12)} first=${(first.ms / 1000).toFixed(2)}s  ` +
    `median=${(median / 1000).toFixed(2)}s  min=${(times[0] / 1000).toFixed(2)}s  ` +
    `max=${(times.at(-1) / 1000).toFixed(2)}s  proof=${proofBytes}B`,
  );
  return run;
}

const ctx4 = deploy(pureCircuits.answerHash4(priv.m4));
const ctx8 = deploy(pureCircuits.answerHash8(priv.m8));

console.log(`proof server ${PROOF_SERVER}, ${RUNS} timed runs per circuit after one warm-up\n`);
await bench('checkOnly', ctx4);
await bench('encryptOnly', ctx4);
const submitted = await bench('submit4', ctx4);
await bench('submit8', ctx8);
await bench('submitSha', ctx4);

// Q4 round trip: the poster reads the ledger after submit4 and decrypts.
const state = ledger(submitted.context.currentQueryContext.state);
const decrypted = pureCircuits.decrypt4(state.c4, state.ephemeralPk, posterSk, BOUNTY_ID);
const ok = decrypted.every((v, i) => v === priv.m4[i]);
const changed = state.c4.every((v, i) => v !== priv.m4[i]);
console.log(`\nround trip: ciphertext differs from answer=${changed}, poster decrypts to the answer=${ok}`);

// A wrong key must not decrypt.
const wrong = pureCircuits.decrypt4(state.c4, state.ephemeralPk, posterSk + 1n, BOUNTY_ID);
console.log(`round trip: wrong key recovers the answer=${wrong.every((v, i) => v === priv.m4[i])}`);
if (!ok || !changed) process.exit(1);

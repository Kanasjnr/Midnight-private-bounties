// Spike Q2 contract wiring for bounty_escrow.compact.
//
// Runs inside a midnight-examples checkout (examples/bounty-escrow-spike).

import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export {
  Contract as BountyContract,
  ledger as bountyLedger,
  Status,
  type Ledger as BountyLedger,
  type ImpureCircuits as BountyImpureCircuits,
} from './managed/bounty_escrow/contract/index.js';

import { bountyWitnesses } from './witnesses.js';
import { Contract as BountyContractClass } from './managed/bounty_escrow/contract/index.js';

// fileURLToPath, not URL.pathname: the latter keeps %20 for a space in the path.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const bountyZkConfigPath = path.resolve(currentDir, 'managed', 'bounty_escrow');

export const CompiledBountyContract = CompiledContract.make(
  'BountyContract',
  BountyContractClass,
).pipe(
  CompiledContract.withWitnesses(bountyWitnesses),
  CompiledContract.withCompiledFileAssets(bountyZkConfigPath),
);

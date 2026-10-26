// Contract wiring for Private Bounties. Resolves against contract/managed/,
// which `yarn compile` generates (gitignored).

import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Contract as BountyPreimageContractClass } from './managed/bounty_preimage/contract/index.js';
import { Contract as BountyFactorContractClass } from './managed/bounty_factor/contract/index.js';
import { Contract as TestTokenContractClass } from './managed/test_token/contract/index.js';
import { bountyWitnesses } from './witnesses.js';

export {
  Contract as BountyPreimageContract,
  ledger as bountyPreimageLedger,
  pureCircuits as bountyPreimagePureCircuits,
  Status,
  type Bounty,
  type Delivery,
  type Ledger as BountyPreimageLedger,
  type ImpureCircuits as BountyPreimageImpureCircuits,
} from './managed/bounty_preimage/contract/index.js';

export {
  Contract as BountyFactorContract,
  ledger as bountyFactorLedger,
  pureCircuits as bountyFactorPureCircuits,
  type Ledger as BountyFactorLedger,
  type ImpureCircuits as BountyFactorImpureCircuits,
} from './managed/bounty_factor/contract/index.js';

export {
  Contract as TestTokenContract,
  type ImpureCircuits as TestTokenImpureCircuits,
} from './managed/test_token/contract/index.js';

// fileURLToPath, not URL.pathname: the latter keeps %20 for spaces in the path.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const bountyPreimageZkConfigPath = path.resolve(currentDir, 'managed', 'bounty_preimage');
export const bountyFactorZkConfigPath = path.resolve(currentDir, 'managed', 'bounty_factor');
export const testTokenZkConfigPath = path.resolve(currentDir, 'managed', 'test_token');

export const CompiledBountyPreimageContract = CompiledContract.make(
  'BountyPreimageContract',
  BountyPreimageContractClass,
).pipe(
  CompiledContract.withWitnesses(bountyWitnesses),
  CompiledContract.withCompiledFileAssets(bountyPreimageZkConfigPath),
);

// Same witnesses: every template reads the same three private inputs.
export const CompiledBountyFactorContract = CompiledContract.make(
  'BountyFactorContract',
  BountyFactorContractClass,
).pipe(
  CompiledContract.withWitnesses(bountyWitnesses),
  CompiledContract.withCompiledFileAssets(bountyFactorZkConfigPath),
);

// Test-only: the reward token for local networks and testnets.
export const CompiledTestTokenContract = CompiledContract.make(
  'TestTokenContract',
  TestTokenContractClass,
).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(testTokenZkConfigPath),
);

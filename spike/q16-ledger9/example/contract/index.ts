// Spike Q16: our test token and preimage bounty, compiled with toolchain 0.36.0
// (Ledger 9). Resolves against contract/managed/, which `npm run compile` makes.
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Contract as BountyPreimageContractClass } from './managed/bounty_preimage/contract/index.js';
import { Contract as TestTokenContractClass } from './managed/test_token/contract/index.js';
import { bountyWitnesses } from './witnesses.js';

export {
  ledger as bountyPreimageLedger,
  pureCircuits as bountyPreimagePureCircuits,
  Status,
  type Ledger as BountyPreimageLedger,
} from './managed/bounty_preimage/contract/index.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const bountyPreimageZkConfigPath = path.resolve(currentDir, 'managed', 'bounty_preimage');
export const testTokenZkConfigPath = path.resolve(currentDir, 'managed', 'test_token');

export const CompiledBountyPreimageContract = CompiledContract.make('bounty_preimage', BountyPreimageContractClass).pipe(
  CompiledContract.withWitnesses(bountyWitnesses),
  CompiledContract.withCompiledFileAssets(bountyPreimageZkConfigPath),
);

export const CompiledTestTokenContract = CompiledContract.make('test_token', TestTokenContractClass).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(testTokenZkConfigPath),
);

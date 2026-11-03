// Copies every compiled contract's keys and zkir into public/managed/, where
// the providers fetch them (FetchZkConfigProvider, from the page's origin).
// The same job as ../ui/scripts/copy-zk.mjs, for this package's public/.
// Run `yarn compile` in examples/private-bounties first: `compile:fast` makes
// no keys.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const range = JSON.parse(readFileSync(path.resolve(here, "../../../../package.json"), "utf8")).engines?.node;
const min = Number(/^>=\s*(\d+)/.exec(range ?? "")?.[1]);
if (min && Number(process.versions.node.split(".")[0]) < min) {
  console.error(`[copy:zk] Node ${process.versions.node} is too old: this repo needs Node ${range}. Try \`nvm use\`.`);
  process.exit(1);
}

const managed = path.resolve(here, "../../contract/managed");
const contracts = existsSync(managed)
  ? readdirSync(managed).filter((c) => ["keys", "zkir"].every((dir) => existsSync(path.join(managed, c, dir))))
  : [];
if (!contracts.includes("bounty_preimage") || !contracts.includes("test_token")) {
  console.error(
    `[copy:zk] No proving keys for bounty_preimage and test_token in ${managed}.\n` +
      "Compile the contracts first:  yarn workspace @midnight-ntwrk/example-private-bounties run compile",
  );
  process.exit(1);
}

const destRoot = path.resolve(here, "../public/managed");
rmSync(destRoot, { recursive: true, force: true });
for (const c of contracts) {
  for (const dir of ["keys", "zkir"]) {
    cpSync(path.join(managed, c, dir), path.join(destRoot, c, dir), { recursive: true });
  }
}
console.log(`[copy:zk] ${contracts.join(", ")} → public/managed/`);

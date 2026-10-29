// Deploys the mocks on a local node and plays out the October 2026 launch: claims (mints), vault deposits, merge
// ladders up to level 6 (in wallets and inside the vault), transfers and withdrawals.
import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { hardhat } from "viem/chains";

const ROOT = path.resolve(import.meta.dirname, "..");

export function compileMocks() {
  const src = fs.readFileSync(path.join(ROOT, "test/contracts/Mocks.sol"), "utf8");
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "Mocks.sol": { content: src } },
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  })));
  const errs = (out.errors ?? []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["Mocks.sol"];
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { abi: v.abi, bytecode: `0x${v.evm.bytecode.object}` }]));
}

export async function seed(rpc) {
  const A = compileMocks();
  const transport = http(rpc);
  const pub = createPublicClient({ chain: hardhat, transport });
  const wallet = createWalletClient({ chain: hardhat, transport });
  const acct = await wallet.getAddresses();
  const deployer = acct[0];

  const deploy = async (name, args = []) => {
    const hash = await wallet.deployContract({ account: deployer, abi: A[name].abi, bytecode: A[name].bytecode, args, chain: hardhat });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
  };
  const send = async (from, address, name, fn, args = []) => {
    const hash = await wallet.writeContract({ account: from, address, abi: A[name].abi, functionName: fn, args, chain: hardhat, gas: 15_000_000n });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${fn} reverted`);
    return r;
  };
  const read = (address, name, fn, args = []) => pub.readContract({ address, abi: A[name].abi, functionName: fn, args });

  const core = await deploy("MockCore");
  const nft = await deploy("MockSealed", [core]);
  const vault = await deploy("MockVault", [nft]);
  const multicall = await deploy("Multicall3Lite");
  await send(deployer, nft, "MockSealed", "setVault", [vault]);
  await send(deployer, core, "MockCore", "setHeight", [4000n, 650n]);

  // claims: two whales, a few mid holders, a long tail
  const plan = [0, 140, 90, 60, 45, 30, 24, 20, 16, 12, 10, 8, 8, 6, 5, 4, 3, 2, 2, 1];
  const owned = new Map(acct.map((a) => [a, []]));
  for (let i = 1; i < plan.length; i++) {
    let left = plan[i];
    while (left > 0) {
      const n = Math.min(50, left);
      const first = Number(await read(nft, "MockSealed", "nextId"));
      await send(acct[i], nft, "MockSealed", "mint", [acct[i], BigInt(n)]);
      for (let k = 0; k < n; k++) owned.get(acct[i]).push(first + k);
      left -= n;
    }
  }
  const all = [...owned.values()].flat();
  const inVault = new Set();
  const deposit = async (a, ids) => {
    if (!ids.length) return;
    await send(a, nft, "MockSealed", "setApprovalForAll", [vault, true]);
    for (let i = 0; i < ids.length; i += 50) await send(a, vault, "MockVault", "deposit", [nft, ids.slice(i, i + 50).map(BigInt)]);
    ids.forEach((id) => inVault.add(id));
  };
  // whales and some mid holders stake everything first, so their merges happen inside the vault
  await deposit(acct[1], owned.get(acct[1]));
  await deposit(acct[3], owned.get(acct[3]).slice(0, 40));

  // merge ladders: pair up same-level Squeeks; the second of each pair is burned
  const level = new Map(all.map((id) => [id, 1]));
  async function ladder(a, rounds) {
    for (let r = 0; r < rounds; r++) {
      const byLevel = new Map();
      for (const id of owned.get(a)) { const l = level.get(id); if (!byLevel.has(l)) byLevel.set(l, []); byLevel.get(l).push(id); }
      for (const [l, list] of byLevel) {
        for (let i = 0; i + 1 < list.length && i < 2 * Math.max(1, Math.floor(list.length / 3)); i += 2) {
          const [s, d] = [list[i], list[i + 1]];
          await send(a, nft, "MockSealed", "merge", [BigInt(s), BigInt(d)]);
          level.set(s, l + 1); level.delete(d); inVault.delete(d);
          owned.set(a, owned.get(a).filter((x) => x !== d));
        }
      }
    }
  }
  await ladder(acct[1], 6);
  await ladder(acct[2], 4);
  await ladder(acct[3], 3);
  await ladder(acct[4], 2);
  await ladder(acct[5], 1);

  // later stakers, transfers and a withdrawal
  await deposit(acct[2], owned.get(acct[2]));
  await deposit(acct[7], owned.get(acct[7]).slice(0, 10));
  const give = owned.get(acct[6]).slice(0, 4);
  for (const id of give) {
    await send(acct[6], nft, "MockSealed", "transferFrom", [acct[6], acct[18], BigInt(id)]);
    owned.set(acct[18], [...owned.get(acct[18]), id]);
  }
  owned.set(acct[6], owned.get(acct[6]).slice(4));
  const back = owned.get(acct[7]).slice(0, 3);
  await send(acct[7], vault, "MockVault", "withdraw", [back.map(BigInt)]);
  back.forEach((id) => inVault.delete(id));
  // 10,000 core blocks later: L2 (3,000) and L3 (7,000) cooldowns are over, L4+ (14,000+) still running
  await send(deployer, core, "MockCore", "setHeight", [14000n, 900n]);

  return { core, nft, vault, multicall, accounts: acct, live: level.size, minted: all.length, inVault: inVault.size, level };
}

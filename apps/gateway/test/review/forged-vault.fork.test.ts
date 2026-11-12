import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  type Address,
  type Hex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeDeployData,
  getAddress,
  http,
  keccak256,
  parseEther,
  parseEventLogs,
  stringToHex,
  toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { beforeAll, describe, expect, it } from 'vitest';

import { identityRegistryAbi, mandateVaultAbi } from '../../src/chain/abis';
import { createPaymentExecutor } from '../../src/chain/executor';
import { createChainReader } from '../../src/chain/reader';
import { Gateway } from '../../src/gateway';
import { signIntent } from '../../src/protocol/intent';
import { EvidenceStore } from '../../src/store/evidenceStore';
import { Ledger } from '../../src/store/ledger';
import { PayeeDirectory } from '../../src/store/payees';
import { createVerifierChain, verifyEvidence } from '../../src/verify';

/**
 * Review finding, end to end on a local fork of Arbitrum Sepolia: evidence about a vault that is not
 * the company's passes `pnpm verify-evidence`.
 *
 * An outsider deploys their own copy of MandateVault (the verified source is public), registers an
 * agent of their own in the real ERC-8004 registry, and runs this repository's gateway against it. The
 * evidence file that comes out is honest about *their* vault. Handed to somebody as "the record of your
 * agent's payment", it verifies: the verifier checks whatever vault the file names, and its report
 * does not say which vault that was.
 *
 *   forge build                                    (in apps/contracts: the test deploys the built vault)
 *   anvil --fork-url https://sepolia-rollup.arbitrum.io/rpc --port 8546
 *   REVIEW_FORK_RPC_URL=http://127.0.0.1:8546 pnpm --filter @agent-gateway/gateway exec vitest run test/review/forged-vault.fork.test.ts
 *
 * Nothing is sent to a live network: every transaction goes to the local fork.
 */
const fork = process.env.REVIEW_FORK_RPC_URL;
const rpcUrl = fork ?? 'http://127.0.0.1:8546';
const artifact = new URL(
  '../../../contracts/out/MandateVault.sol/MandateVault.json',
  import.meta.url,
);

const COMPANY_VAULT = getAddress('0x7293763f6b73783834484cd976528d01cb6c8ccf');
const USDC = getAddress('0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d');
const REGISTRY = getAddress('0x8004a818bfb912233c491871b3d84c89a494bd9e');
const run = promisify(execFile);

describe.skipIf(fork === undefined || !existsSync(artifact))(
  'review: a stranger’s vault passes verify-evidence (fork)',
  () => {
    const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
    const anvil = createTestClient({ mode: 'anvil', transport: http(rpcUrl) });

    // The forger's own keys. None of them has any role in the company's vault.
    const forger = privateKeyToAccount(generatePrivateKey());
    const forgerExecutor = privateKeyToAccount(generatePrivateKey());
    const forgerAgent = privateKeyToAccount(generatePrivateKey());
    // The address the forged record claims was paid, under a name copied from the company's registry.
    const payee = getAddress('0xdd76243f8563ea5d6e6186c0e26804f761a18792');

    let dir = '';
    let evidencePath = '';
    let forgedVault: Address;

    const wallet = (account: typeof forger) =>
      createWalletClient({ account, chain: arbitrumSepolia, transport: http(rpcUrl) });

    beforeAll(async () => {
      expect(await publicClient.getChainId()).toBe(421_614);
      for (const account of [forger, forgerExecutor, forgerAgent]) {
        await anvil.setBalance({ address: account.address, value: parseEther('0.05') });
      }

      // 1. The forger deploys a vault of their own, wired to the real USDC and the real registry.
      const { bytecode } = JSON.parse(readFileSync(artifact, 'utf8')) as {
        bytecode: { object: Hex };
      };
      const deployment = await publicClient.waitForTransactionReceipt({
        hash: await wallet(forger).sendTransaction({
          data: encodeDeployData({
            abi: mandateVaultAbi,
            bytecode: bytecode.object,
            args: [USDC, forger.address, REGISTRY],
          }),
        }),
      });
      forgedVault = getAddress(deployment.contractAddress as Address);

      // 2. Anyone can register an agent in the ERC-8004 registry. The wallet is the forger's.
      const registration = await publicClient.waitForTransactionReceipt({
        hash: await wallet(forgerAgent).writeContract({
          address: REGISTRY,
          abi: identityRegistryAbi,
          functionName: 'register',
        }),
      });
      const registered = parseEventLogs({
        abi: identityRegistryAbi,
        logs: registration.logs,
        eventName: 'Registered',
      })[0];
      if (registered === undefined) throw new Error('the registry did not emit Registered');
      const agentId = registered.args.agentId;

      // 3. Six test USDC in the forger's vault (a faucet gives these away; here the fork is told so).
      const slot = keccak256(
        encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [forgedVault, 9n]),
      );
      await anvil.setStorageAt({
        address: USDC,
        index: slot,
        value: toHex(6_000_000n, { size: 32 }),
      });

      // 4. A mandate in the forger's vault that lets their gateway pay the payee 6 USDC.
      const block = await publicClient.getBlock({ blockTag: 'latest' });
      await publicClient.waitForTransactionReceipt({
        hash: await wallet(forger).writeContract({
          address: forgedVault,
          abi: mandateVaultAbi,
          functionName: 'createMandate',
          args: [
            agentId,
            forgerExecutor.address,
            privateKeyToAccount(generatePrivateKey()).address,
            [payee],
            20_000_000n,
            20_000_000n,
            20_000_000n,
            block.timestamp + 30n * 86_400n,
            keccak256(stringToHex('terms')),
          ],
        }),
      });

      // 5. This repository's gateway, unchanged, run against the forger's vault.
      dir = await mkdtemp(join(tmpdir(), 'agw-forged-'));
      const gateway = new Gateway({
        chain: createChainReader(publicClient, forgedVault),
        executor: createPaymentExecutor(publicClient, wallet(forgerExecutor), forgedVault),
        ledger: await Ledger.open(join(dir, 'ledger.jsonl')),
        evidence: new EvidenceStore(join(dir, 'evidence')),
        loadPayees: () =>
          Promise.resolve(
            new PayeeDirectory({
              vendors: [{ name: 'Nagikumo Research', address: payee }],
              denylist: [],
            }),
          ),
      });
      const latest = await publicClient.getBlock({ blockTag: 'latest' });
      const outcome = await gateway.submit(
        await signIntent(
          forgerAgent,
          { chainId: 421_614, vault: forgedVault },
          {
            agentId: agentId.toString(),
            payee,
            amount: '6000000',
            purpose: 'Invoice NR-2026-0042: quarterly sector report',
            invoiceId: 'NR-2026-0042',
            context: {},
            nonce: keccak256(stringToHex('forged request')),
            expiresAt: Number(latest.timestamp) + 300,
          },
        ),
      );
      expect(outcome.status).toBe('paid');
      const [name] = await readdir(join(dir, 'evidence'));
      evidencePath = join(dir, 'evidence', name as string);

      return async () => {
        await rm(dir, { recursive: true, force: true });
      };
    }, 120_000);

    it('the forged vault is not the company’s vault', () => {
      expect(forgedVault).not.toBe(COMPANY_VAULT);
    });

    it('verifyEvidence must refuse it when asked about the company’s vault', async () => {
      const file: unknown = JSON.parse(readFileSync(evidencePath, 'utf8'));
      const options = {
        chain: createVerifierChain(publicClient),
        expected: { chainId: 421_614, vault: COMPANY_VAULT },
      };
      const report = await verifyEvidence(file, options);
      expect(report.verified).toBe(false);
    });

    it('the command line must not print VERIFIED for it', async () => {
      // No --vault given: the reader means the vault this repository records as deployed.
      const cli = new URL('../../src/cli/verify-evidence.ts', import.meta.url).pathname;
      const outcome = await run(
        process.execPath,
        ['--import', 'tsx', cli, evidencePath, '--rpc', rpcUrl],
        { env: { ...process.env, INIT_CWD: '/', MANDATE_VAULT_ADDRESS: '' } },
      ).then(
        (ok) => ({ code: 0, stdout: ok.stdout }),
        (error: { code?: number; stdout?: string }) => ({
          code: error.code ?? -1,
          stdout: error.stdout ?? '',
        }),
      );
      // On main this prints "auto -> paid: 6 USDC to Nagikumo Research (0xDd76…)" and
      // "VERIFIED: 18 of 18 checks passed", with exit code 0, and never names the vault it looked at.
      expect(outcome.stdout).not.toMatch(/^\s*VERIFIED/m);
      expect(outcome.code).toBe(1);
    }, 60_000);
  },
);

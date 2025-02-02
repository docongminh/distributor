import fs from "fs";
import { AccountMeta, Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { AnchorProvider, Program, Wallet, web3 } from "@coral-xyz/anchor";
import {
  MerkleDistributor,
  IDL as MerkleDistributorIDL,
} from "../../target/types/merkle_distributor";
import {
  allocateMerkleTreeAccount,
  encodeU64,
  getOrCreateAssociatedTokenAccountWrap,
} from "../common";
import {
  createAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { LOCKED_VOTER_PROGRAM_ID } from "../locked_voter/setup";
import {
  createAllocTreeIx,
  SPL_ACCOUNT_COMPRESSION_ADDRESS,
  SPL_NOOP_PROGRAM_ID,
} from "../../node_modules/@solana/spl-account-compression/dist/cjs/src";

const MERKLE_DISTRIBUTOR_PROGRAM_ID = new web3.PublicKey(
  "DiS3nNjFVMieMgmiQFm6wgJL7nevk4NrhXKLbtEH1Z2R"
);

const res = fs.readFileSync(
  process.cwd() +
    "/keys/localnet/admin-bossj3JvwiNK7pvjr149DqdtJxf2gdygbcmEPTkb2F1.json",
  "utf8"
);

export function deriveDistributor(
  base: web3.PublicKey,
  mint: web3.PublicKey,
  version: number
) {
  let [pk, _] = web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("MerkleDistributor"),
      base.toBuffer(),
      mint.toBuffer(),
      encodeU64(version),
    ],
    MERKLE_DISTRIBUTOR_PROGRAM_ID
  );
  return pk;
}

export function deriveParentAccount(mint: web3.PublicKey) {
  let [pk, _] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("ParentAccount"), mint.toBuffer()],
    MERKLE_DISTRIBUTOR_PROGRAM_ID
  );
  return pk;
}

export function deriveClaimStatus(
  distributor: web3.PublicKey,
  claimant: web3.PublicKey
) {
  let [pk, _] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("ClaimStatus"), claimant.toBuffer(), distributor.toBuffer()],
    MERKLE_DISTRIBUTOR_PROGRAM_ID
  );
  return pk;
}

export const ADMIN = Keypair.fromSecretKey(new Uint8Array(JSON.parse(res)));

export const ADMIN_PUBKEY = ADMIN.publicKey;

export function createDistributorProgram(
  wallet: Wallet
): Program<MerkleDistributor> {
  const provider = new AnchorProvider(AnchorProvider.env().connection, wallet, {
    maxRetries: 3,
  });
  const program = new Program<MerkleDistributor>(
    MerkleDistributorIDL,
    MERKLE_DISTRIBUTOR_PROGRAM_ID,
    provider
  );
  return program;
}

export interface CreateNewParentAccountParams {
  admin: Keypair;
  mint: PublicKey;
}

export async function createNewParentAccount(
  params: CreateNewParentAccountParams
) {
  let { admin, mint } = params;
  const program = createDistributorProgram(new Wallet(admin));

  let parentAccount = deriveParentAccount(mint);
  let parentVault = await getOrCreateAssociatedTokenAccountWrap(
    program.provider.connection,
    admin,
    mint,
    parentAccount
  );
  await program.methods
    .newParentAccount()
    .accounts({
      parentAccount,
      parentVault,
      mint,
      admin: admin.publicKey,
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc()
    .catch(console.log)
    .then(console.log);

  return { parentAccount, parentVault };
}

export interface CreateNewDisitrbutorParams {
  admin: Keypair;
  version: number;
  root: Buffer;
  startIndex: number;
  maxDepth: any;
  maxBufferSize: any;
  canopyDepth: number;
  canopyNodes: Array<number>[];
  rightmostLeaf: Buffer;
  rightmostIndex: number;
  totalClaim: BN;
  maxNumNodes: BN;
  startVestingTs: BN;
  endVestingTs: BN;
  clawbackStartTs: BN;
  activationPoint: BN;
  activationType: number;
  closable: boolean;
  totalBonus: BN;
  bonusVestingDuration: BN;
  claimType: number;
  operator: PublicKey;
  locker: PublicKey;
  mint: PublicKey;
  clawbackReceiver: PublicKey;
  remainingAccounts: AccountMeta[];
}

export async function createNewDistributor(params: CreateNewDisitrbutorParams) {
  let {
    admin,
    version,
    root,
    startIndex,
    maxDepth,
    maxBufferSize,
    canopyDepth,
    canopyNodes,
    rightmostLeaf,
    rightmostIndex,
    totalClaim,
    maxNumNodes,
    startVestingTs,
    endVestingTs,
    clawbackStartTs,
    activationPoint,
    activationType,
    closable,
    totalBonus,
    bonusVestingDuration,
    claimType,
    operator,
    locker,
    mint,
    clawbackReceiver,
    remainingAccounts,
  } = params;

  console.log(params)
  const program = createDistributorProgram(new Wallet(admin));

  let base = Keypair.generate();

  let distributor = deriveDistributor(base.publicKey, mint, version);
  let parentAccount = deriveParentAccount(mint);
  let tokenVault = await getOrCreateAssociatedTokenAccountWrap(
    program.provider.connection,
    admin,
    mint,
    distributor
  );

  const merkleTreeAccount = await allocateMerkleTreeAccount(
    program.provider.connection,
    admin,
    maxBufferSize,
    maxDepth,
    canopyDepth
  );
  console.log("root: ", Array.from(new Uint8Array(root)))
  await program.methods
    .newDistributor({
      version: new BN(version),
      root: Array.from(new Uint8Array(root)),
      maxDepth,
      maxBufferSize,
      startIndex,
      canopyNodes,
      rightmostLeaf: Array.from(new Uint8Array(rightmostLeaf)),
      rightmostIndex,
      totalClaim,
      maxNumNodes,
      startVestingTs,
      endVestingTs,
      clawbackStartTs,
      activationPoint,
      activationType,
      closable,
      totalBonus,
      bonusVestingDuration,
      claimType,
      operator,
      locker,
      parentAccount,
    })
    .accounts({
      distributor,
      merkleTree: merkleTreeAccount,
      mint,
      clawbackReceiver,
      tokenVault,
      admin: admin.publicKey,
      base: base.publicKey,
      systemProgram: web3.SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      logWrapper: SPL_NOOP_PROGRAM_ID,
      compressionProgram: SPL_ACCOUNT_COMPRESSION_ADDRESS,
    })
    .remainingAccounts(remainingAccounts)
    .signers([base])
    .rpc()
    .catch(console.log)
    .then(console.log);

  return { distributor, tokenVault, merkleTree: merkleTreeAccount };
}

export interface FundDistributorVaultsParams {
  admin: Keypair;
  parentAccount: PublicKey;
  parentVault: PublicKey;
  remainingAccounts: AccountMeta[];
}

export async function fundDistributorVaults(
  params: FundDistributorVaultsParams
) {
  let { admin, remainingAccounts, parentAccount, parentVault } = params;
  const program = createDistributorProgram(new Wallet(admin));

  await program.methods
    .fundDistributorsVault()
    .accounts({
      parentAccount,
      parentVault,
      admin: admin.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(remainingAccounts)
    .rpc()
    .catch(console.log)
    .then(console.log);

  return { parentAccount, parentVault };
}

export interface ClaimParams {
  claimant: Keypair;
  operator?: Keypair;
  distributor: PublicKey;
  amountUnlocked: BN;
  amountLocked: BN;
  proof: Array<number>[];
}

export async function claim(params: ClaimParams) {
  let { claimant, amountUnlocked, amountLocked, proof, distributor, operator } =
    params;
  const program = createDistributorProgram(new Wallet(claimant));

  let distributorState = await program.account.merkleDistributor.fetch(
    distributor
  );
  let claimStatus = deriveClaimStatus(distributor, claimant.publicKey);
  let to = await getOrCreateAssociatedTokenAccountWrap(
    program.provider.connection,
    claimant,
    distributorState.mint,
    claimant.publicKey
  );

  if (operator == null) {
    await program.methods
      .newClaim(amountUnlocked, amountLocked, proof)
      .accounts({
        distributor,
        claimant: claimant.publicKey,
        claimStatus,
        from: distributorState.tokenVault,
        to,
        systemProgram: web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        operator: null,
      })
      .rpc()
      .catch(console.log)
      .then(console.log);
  } else {
    // user sign tx firstly (need to verify signature to avoid spaming)
    let tx = await program.methods
      .newClaim(amountUnlocked, amountLocked, proof)
      .accounts({
        distributor,
        claimant: claimant.publicKey,
        claimStatus,
        from: distributorState.tokenVault,
        to,
        systemProgram: web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        operator: operator.publicKey,
      })
      .transaction();

    // pass tx to operator to sign
    const { blockhash, lastValidBlockHeight } =
      await program.provider.connection.getLatestBlockhash();
    tx.feePayer = claimant.publicKey;
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.partialSign(operator);

    // pass back user to sign
    const signedTx = await new Wallet(claimant).signTransaction(tx);
    const txHash = await program.provider.connection.sendRawTransaction(
      signedTx.serialize()
    );
    console.log(txHash);
  }
}

export interface ClaimAndStakeParams {
  claimant: Keypair;
  escrow: PublicKey;
  operator?: Keypair;
  distributor: PublicKey;
  amountUnlocked: BN;
  amountLocked: BN;
  proof: Array<number>[];
}

// export async function claimAndStake(params: ClaimAndStakeParams) {
//   let {
//     claimant,
//     amountUnlocked,
//     amountLocked,
//     proof,
//     distributor,
//     operator,
//     escrow,
//   } = params;
//   const program = createDistributorProgram(new Wallet(claimant));

//   let distributorState = await program.account.merkleDistributor.fetch(
//     distributor
//   );
//   let claimStatus = deriveClaimStatus(distributor, claimant.publicKey);

//   if (operator == null) {
//     await program.methods
//       .newClaimAndStake(amountUnlocked, amountLocked, proof)
//       .accounts({
//         distributor,
//         claimant: claimant.publicKey,
//         claimStatus,
//         from: distributorState.tokenVault,
//         systemProgram: web3.SystemProgram.programId,
//         tokenProgram: TOKEN_PROGRAM_ID,
//         operator: null,
//         voterProgram: LOCKED_VOTER_PROGRAM_ID,
//         locker: distributorState.locker,
//         escrow,
//         escrowTokens: getAssociatedTokenAddressSync(
//           distributorState.mint,
//           escrow,
//           true
//         ),
//       })
//       .rpc()
//       .catch(console.log)
//       .then(console.log);
//   } else {
//     await program.methods
//       .newClaimAndStake(amountUnlocked, amountLocked, proof)
//       .accounts({
//         distributor,
//         claimant: claimant.publicKey,
//         claimStatus,
//         from: distributorState.tokenVault,
//         systemProgram: web3.SystemProgram.programId,
//         tokenProgram: TOKEN_PROGRAM_ID,
//         operator: operator.publicKey,
//         voterProgram: LOCKED_VOTER_PROGRAM_ID,
//         locker: distributorState.locker,
//         escrow,
//         escrowTokens: getAssociatedTokenAddressSync(
//           distributorState.mint,
//           escrow,
//           true
//         ),
//       })
//       .signers([operator])
//       .rpc()
//       .catch(console.log)
//       .then(console.log);
//   }
// }

export interface ClaimLockedParams {
  claimant: Keypair;
  operator?: Keypair;
  distributor: PublicKey;
}

export async function claimLocked(params: ClaimLockedParams) {
  let { claimant, distributor, operator } = params;
  const program = createDistributorProgram(new Wallet(claimant));

  let distributorState = await program.account.merkleDistributor.fetch(
    distributor
  );
  let claimStatus = deriveClaimStatus(distributor, claimant.publicKey);
  let to = await getOrCreateAssociatedTokenAccountWrap(
    program.provider.connection,
    claimant,
    distributorState.mint,
    claimant.publicKey
  );

  if (operator == null) {
    await program.methods
      .claimLocked()
      .accounts({
        distributor,
        claimant: claimant.publicKey,
        claimStatus,
        from: distributorState.tokenVault,
        to,
        tokenProgram: TOKEN_PROGRAM_ID,
        operator: null,
      })
      .rpc()
      .catch(console.log)
      .then(console.log);
  } else {
    await program.methods
      .claimLocked()
      .accounts({
        distributor,
        claimant: claimant.publicKey,
        claimStatus,
        from: distributorState.tokenVault,
        to,
        tokenProgram: TOKEN_PROGRAM_ID,
        operator: operator.publicKey,
      })
      .signers([operator])
      .rpc()
      .catch(console.log)
      .then(console.log);
  }
}

export interface ClaimLockedAndStakeParams {
  claimant: Keypair;
  operator?: Keypair;
  distributor: PublicKey;
  escrow: PublicKey;
}

// export async function claimLockedAndStake(params: ClaimLockedAndStakeParams) {
//   let { claimant, distributor, operator, escrow } = params;
//   const program = createDistributorProgram(new Wallet(claimant));

//   let distributorState = await program.account.merkleDistributor.fetch(
//     distributor
//   );
//   let claimStatus = deriveClaimStatus(distributor, claimant.publicKey);

//   if (operator == null) {
//     await program.methods
//       .claimLockedAndStake()
//       .accounts({
//         distributor,
//         claimant: claimant.publicKey,
//         claimStatus,
//         from: distributorState.tokenVault,
//         tokenProgram: TOKEN_PROGRAM_ID,
//         operator: null,
//         voterProgram: LOCKED_VOTER_PROGRAM_ID,
//         locker: distributorState.locker,
//         escrow,
//         escrowTokens: getAssociatedTokenAddressSync(
//           distributorState.mint,
//           escrow,
//           true
//         ),
//       })
//       .rpc()
//       .catch(console.log)
//       .then(console.log);
//   } else {
//     await program.methods
//       .claimLockedAndStake()
//       .accounts({
//         distributor,
//         claimant: claimant.publicKey,
//         claimStatus,
//         from: distributorState.tokenVault,
//         tokenProgram: TOKEN_PROGRAM_ID,
//         operator: operator.publicKey,
//         voterProgram: LOCKED_VOTER_PROGRAM_ID,
//         locker: distributorState.locker,
//         escrow,
//         escrowTokens: getAssociatedTokenAddressSync(
//           distributorState.mint,
//           escrow,
//           true
//         ),
//       })
//       .signers([operator])
//       .rpc()
//       .catch(console.log)
//       .then(console.log);
//   }
// }

export interface ClawbackParams {
  payer: Keypair;
  distributor: PublicKey;
}

export async function clawBack(params: ClawbackParams) {
  let { payer, distributor } = params;
  const program = createDistributorProgram(new Wallet(payer));

  let distributorState = await program.account.merkleDistributor.fetch(
    distributor
  );

  await program.methods
    .clawback()
    .accounts({
      distributor,
      from: distributorState.tokenVault,
      clawbackReceiver: distributorState.clawbackReceiver,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc()
    .catch(console.log)
    .then(console.log);
}

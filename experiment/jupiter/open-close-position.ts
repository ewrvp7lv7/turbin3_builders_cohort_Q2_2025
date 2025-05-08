/**
 *  Jupiter Perpetuals – open & close example.
 *
 *  USAGE
 *  -----
 *  # set RPC_URL and KEYPAIR in a .env (or replace inline)
 *  ts-node jupiter-perps.ts
 */

import {
  AnchorProvider,
  BN,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import "dotenv/config";
import { generatePositionPda, generatePositionRequestPda } from "./examples/generate-position-and-position-request-pda";
import {
  CUSTODY_PUBKEY,
  JUPITER_PERPETUALS_PROGRAM_ID,
  JLP_POOL_ACCOUNT_PUBKEY
} from "./constants";
import { MAINNET_RPC_URL, loadKeypair } from "./utils";
import IDL from "../idl/jupiter-perpetuals-idl-json.json";
import { Perpetuals } from "../idl/jupiter-perpetuals-idl";
// ─────────────────────────────────────────────────────────────────────────

const keypair = loadKeypair();

const connection = new Connection(
  MAINNET_RPC_URL
);

const PROGRAM = new Program<Perpetuals>(
  IDL as any,
  JUPITER_PERPETUALS_PROGRAM_ID,
  new AnchorProvider(connection, new Wallet(keypair), {
    commitment: "confirmed",
  })
);

// Jupiter Perpetuals State
const perpetuals = PublicKey.findProgramAddressSync(
  [Buffer.from("perpetuals")],
  JUPITER_PERPETUALS_PROGRAM_ID
)[0];

const COLLATERAL_USDC_CUSTODY = new PublicKey(CUSTODY_PUBKEY.USDC);
const CUSTODY = new PublicKey(CUSTODY_PUBKEY.BTC);

// choose which token you want back; here we redeem as USDC
const mintUSDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC mint

// Need a wrapped‑SOL ATA that lives *under the positionRequest PDA*
const fundingAccount = getAssociatedTokenAddressSync(
  mintUSDC,
  keypair.publicKey,
  true
);

// ─────────────────────────────────────────────────────────────────────────
//  OPEN position                                                          ─
export async function openPerpPosition(params: {
  side: "long" | "short";
  sizeUsd: number;             // e.g. 100  ==  $100 notional
  collateralSol: number;       // lamports of SOL to post
  maxPriceSlippagePct?: number // default 1 %
}) {
  const {
    side,
    sizeUsd,
    collateralSol,
    maxPriceSlippagePct = 1,
  } = params;

  // basic inputs
  const owner = keypair.publicKey;
  const sizeUsdDelta = new BN(sizeUsd * 1e6);            // USDC 6 decimals
  const collateralDelta = new BN(collateralSol);

  // derive PDAs
  // #7 - Position
  const { position: positionPda } = generatePositionPda({
    custody: CUSTODY,
    collateralCustody: COLLATERAL_USDC_CUSTODY,
    walletAddress: keypair.publicKey,
    side,
  });

  const { positionRequest, counter } = generatePositionRequestPda({
    positionPubkey: positionPda,
    requestChange: "increase",
  });

  const positionRequestAta = getAssociatedTokenAddressSync(mintUSDC, positionRequest, true);


  // Quoting – only needed when the trade requires a swap (SOL→SOL doesn't),
  // but I include the pattern for completeness.
  const jupiterMinimumOut = null; // leave null for native SOL longs

  // wrong! Slippage in quote units (USDC 6dp)
  const priceSlippage = new BN(
    (maxPriceSlippagePct / 100) * 1e6 * 1 // $1 in quote units
  );

  // priceSlippage **increase** position should be less for long positions and greater for shorts
  // priceSlippage based on current price (SOL/USD price, for example)
  // const priceSlippage = price * 101 / 100; // 1% slippage for long
  // const priceSlippage = price * 99 / 100; // 1% slippage for short



  // — Build instruction list —
  const preIxs = [
    // create wSOL ATA
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      fundingAccount,
      positionRequest,
      mintUSDC
    ),
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: fundingAccount,
      lamports: BigInt(collateralDelta.toString()),
    }),
    createSyncNativeInstruction(fundingAccount),
  ];
  const increaseIx = await PROGRAM.methods
    .createIncreasePositionMarketRequest({
      counter,
      collateralTokenDelta: collateralDelta,
      jupiterMinimumOut,
      priceSlippage,
      side: side === "long" ? { long: {} } : { short: {} },
      sizeUsdDelta,
    })
    .accounts({
      // mandatory accounts
      owner,
      pool: JLP_POOL_ACCOUNT_PUBKEY,
      position: positionPda,
      positionRequest,
      positionRequestAta,
      custody: CUSTODY,
      collateralCustody: COLLATERAL_USDC_CUSTODY,
      fundingAccount,
      inputMint: mintUSDC,
      perpetuals,
      referral: null,
    })
    .instruction();

  // compute budget – sim first to size it correctly
  const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const simMessage = new TransactionMessage({
    payerKey: owner,
    recentBlockhash,
    instructions: preIxs.concat(increaseIx),
  }).compileToV0Message();
  const simTx = new VersionedTransaction(simMessage);
  const sim = await connection.simulateTransaction(simTx, {
    replaceRecentBlockhash: true,
    sigVerify: false,
  });
  const cuLimit = sim.value.unitsConsumed ?? 1_400_000;

  // final tx
  const txMsg = new TransactionMessage({
    payerKey: owner,
    recentBlockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ...preIxs,
      increaseIx,
      // close wSOL ATA after keeper executes
      createCloseAccountInstruction(fundingAccount, owner, owner),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(txMsg);
  tx.sign([keypair]);
  const sig = await connection.sendTransaction(tx, {
    skipPreflight: true,
  });
  console.log("📤  open request sent:", sig);
}

// ─────────────────────────────────────────────────────────────────────────
//  CLOSE (full)                                                           ─
export async function closePerpPosition(positionPda: PublicKey) {
  const position = await PROGRAM.account.position.fetch(positionPda);

  if (!position || position.sizeUsd.isZero()) {
    console.error("❌ Empty position!");
    return;
  }

  const { positionRequest, counter } = generatePositionRequestPda({
    positionPubkey: positionPda,
    requestChange: "decrease",
  });

  // choose which token you want back; here we redeem as SOL
  const desiredMint = mintUSDC;
  const positionRequestAta = getAssociatedTokenAddressSync(desiredMint, positionRequest, true);


    // wrong!
    const priceSlippage = new BN(10_000_000_000);
  
    // priceSlippage for **decrease** position should be greater for long positions and less for shorts
    // priceSlippage based on current price (SOL/USD price, for example)
    // const priceSlippage = price * 99 / 100; // 1% slippage for long
    // const priceSlippage = price * 101 / 100; // 1% slippage for short

  const decIx = await PROGRAM.methods
    .createDecreasePositionMarketRequest({
      collateralUsdDelta: new BN(0),
      sizeUsdDelta: new BN(0),
      priceSlippage: new BN(10_000_000_000), // 1% slippage
      jupiterMinimumOut: null,
      counter: new BN(counter),
      entirePosition: true,
    })
    .accounts({
      owner: keypair.publicKey,
      pool: JLP_POOL_ACCOUNT_PUBKEY,
      position: positionPda,
      positionRequest,
      positionRequestAta,
      custody: CUSTODY,
      collateralCustody: COLLATERAL_USDC_CUSTODY,
      desiredMint,
      receivingAccount: fundingAccount,
      perpetuals,
      referral: null,
    })
    .instruction();

  const bh = (await connection.getLatestBlockhash()).blockhash;
  const msg = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: bh,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      decIx,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([keypair]);

  const sig = await connection.sendTransaction(tx, { skipPreflight: true });
  console.log("📤  close request sent:", sig);
}

// ─────────────────────────────────────────────────────────────────────────
//  DEMO – open 0.1 SOL long worth $100, then close it                     ─
(async () => {

  const keypair = loadKeypair();

  console.log("using wallet: ", keypair.publicKey.toBase58());

  console.log("Opening position...");

  const sig = await openPerpPosition({
    side: "long",
    sizeUsd: 5,
    collateralSol: 0.1 * 1e9, // lamports
  });

  console.log("Position opened with signature: ", sig);

  console.log("Closing position...");
  // wait a few seconds then close the exact same position
  // (you'd normally fetch the PDA list first)
  const { position: positionPda } = generatePositionPda({
    custody: CUSTODY,
    collateralCustody: COLLATERAL_USDC_CUSTODY,
    walletAddress: keypair.publicKey,
    side: "long",
  });

  await closePerpPosition(positionPda);
})();

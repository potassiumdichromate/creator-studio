import { ethers } from "ethers";
import { getDatabase } from "./databaseService.js";

const PAYMENTS_COLLECTION = process.env.ZERO_G_PAYMENTS_COLLECTION || "zero_g_generation_payments";

function paymentRpcUrl() {
  return process.env.ZERO_G_PAYMENT_RPC_URL
    || process.env.ZERO_G_MAINNET_RPC_URL
    || process.env.WEB3_PROVIDER_URL
    || "https://evmrpc.0g.ai";
}

function expectedChainId() {
  const value = Number(process.env.ZERO_G_PAYMENT_CHAIN_ID || process.env.ZERO_G_MAINNET_CHAIN_ID || 16661);
  return Number.isFinite(value) && value > 0 ? BigInt(value) : 16661n;
}

export function getZeroGPaymentConfig() {
  return {
    chainId: Number(expectedChainId()),
    rpcUrl: paymentRpcUrl(),
    treasuryWallet: process.env.ZERO_G_TREASURY_WALLET || "",
    contractAddress: process.env.ZERO_G_PAYMENT_CONTRACT_ADDRESS || process.env.CONTRACT_ADDRESS || "",
    confirmations: Number(process.env.ZERO_G_PAYMENT_CONFIRMATIONS || 1)
  };
}

function normalizeAddress(address, name) {
  try {
    return ethers.getAddress(String(address ?? ""));
  } catch {
    const error = new Error(`${name} must be a valid EVM address`);
    error.status = 500;
    throw error;
  }
}

function normalizeTxHash(txHash) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(String(txHash ?? ""))) {
    const error = new Error("A valid 0G payment transaction hash is required");
    error.status = 400;
    throw error;
  }
  return txHash.toLowerCase();
}

async function paymentCollection() {
  const database = await getDatabase();
  const collection = database.collection(PAYMENTS_COLLECTION);
  await collection.createIndex({ txHash: 1 }, { unique: true, name: "zero_g_payment_txHash_unique" });
  return collection;
}

export async function verifyAndRecordGenerationPayment({ txHash, creatorId, amount0G }) {
  const normalizedTxHash = normalizeTxHash(txHash);
  const payer = normalizeAddress(creatorId, "Authenticated wallet");
  const config = getZeroGPaymentConfig();
  const treasury = normalizeAddress(config.treasuryWallet, "ZERO_G_TREASURY_WALLET");
  const requiredValue = ethers.parseEther(String(amount0G));
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, Number(config.chainId));
  const network = await provider.getNetwork();
  if (network.chainId !== expectedChainId()) {
    const error = new Error(`Connected RPC is not 0G mainnet chain ${config.chainId}`);
    error.status = 500;
    throw error;
  }

  const [transaction, receipt] = await Promise.all([
    provider.getTransaction(normalizedTxHash),
    provider.getTransactionReceipt(normalizedTxHash)
  ]);

  if (!transaction || !receipt) {
    const error = new Error("0G payment transaction was not found or is not mined yet");
    error.status = 402;
    error.code = "PAYMENT_NOT_CONFIRMED";
    throw error;
  }
  if (receipt.status !== 1) {
    const error = new Error("0G payment transaction failed on-chain");
    error.status = 402;
    error.code = "PAYMENT_FAILED";
    throw error;
  }
  if (transaction.from.toLowerCase() !== payer.toLowerCase()) {
    const error = new Error("0G payment must be sent from the connected wallet");
    error.status = 403;
    error.code = "PAYMENT_SENDER_MISMATCH";
    throw error;
  }
  if (!transaction.to || transaction.to.toLowerCase() !== treasury.toLowerCase()) {
    const error = new Error("0G payment was not sent to the configured treasury wallet");
    error.status = 402;
    error.code = "PAYMENT_RECIPIENT_MISMATCH";
    throw error;
  }
  if (transaction.value < requiredValue) {
    const error = new Error(`0G payment amount is too low. Required ${amount0G} 0G.`);
    error.status = 402;
    error.code = "PAYMENT_AMOUNT_TOO_LOW";
    throw error;
  }

  const confirmations = Number(config.confirmations);
  if (Number.isFinite(confirmations) && confirmations > 0) {
    const currentBlock = await provider.getBlockNumber();
    const txConfirmations = currentBlock - receipt.blockNumber + 1;
    if (txConfirmations < confirmations) {
      const error = new Error(`0G payment needs ${confirmations} confirmation(s) before generating.`);
      error.status = 402;
      error.code = "PAYMENT_NOT_CONFIRMED";
      throw error;
    }
  }

  const collection = await paymentCollection();
  try {
    await collection.insertOne({
      txHash: normalizedTxHash,
      payer,
      treasury,
      amountWei: transaction.value.toString(),
      requiredAmountWei: requiredValue.toString(),
      blockNumber: receipt.blockNumber,
      chainId: Number(config.chainId),
      createdAt: new Date()
    });
  } catch (error) {
    if (error?.code === 11000) {
      const conflict = new Error("This 0G payment transaction has already been used");
      conflict.status = 409;
      conflict.code = "PAYMENT_ALREADY_USED";
      throw conflict;
    }
    throw error;
  }

  return {
    txHash: normalizedTxHash,
    payer,
    treasury,
    amountWei: transaction.value.toString(),
    blockNumber: receipt.blockNumber,
    chainId: Number(config.chainId)
  };
}

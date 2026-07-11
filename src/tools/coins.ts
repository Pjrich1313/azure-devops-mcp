// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHmac } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const COINS_TOOLS = {
  get_coinbase_balance: "get_coinbase_balance",
  get_ethereum_balance: "get_ethereum_balance",
  get_bitcoin_balance: "get_bitcoin_balance",
  query_all_balances: "query_all_balances",
  next_string_to_payout: "next_string_to_payout",
};

const PAMELA_MENOPOOL_PROJECT = "Pamela Menopool";
const DEFAULT_COINBASE_BASE_URL = "https://api.exchange.coinbase.com";
const DEFAULT_ETHEREUM_RPC_URL = "https://ethereum-rpc.publicnode.com";
const DEFAULT_BITCOIN_API_BASE_URL = "https://blockstream.info/api";
const ERC20_BALANCE_OF_SELECTOR = "70a08231";
const ERC20_DECIMALS_SELECTOR = "313ce567";

interface CoinbaseAccount {
  id?: string;
  currency?: string;
  balance?: string;
  available?: string;
  hold?: string;
  profile_id?: string;
}

interface EthereumRpcResponse<T> {
  result?: T;
  error?: {
    code?: number;
    message?: string;
  };
}

interface BitcoinAddressStats {
  funded_txo_sum?: number;
  spent_txo_sum?: number;
}

interface BitcoinAddressResponse {
  chain_stats?: BitcoinAddressStats;
  mempool_stats?: BitcoinAddressStats;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error occurred";
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function readEnvValue(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function encodePayoutComponent(value: string): string {
  return encodeURIComponent(value.trim());
}

function isPositiveDecimalString(value: string): boolean {
  const trimmed = value.trim();
  return /^\d+(\.\d+)?$/.test(trimmed) && Number.parseFloat(trimmed) > 0;
}

function addOptionalPayoutComponent(parts: string[], key: string, value?: string): void {
  if (value && value.trim().length > 0) {
    parts.push(`${key}=${encodePayoutComponent(value)}`);
  }
}

function ensureHexAddress(address: string, fieldName: string): void {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error(`${fieldName} must be a valid 0x-prefixed 20-byte hex address`);
  }
}

function parseHexToBigInt(value: string, fieldName: string): bigint {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`Invalid hex response for ${fieldName}`);
  }
  return BigInt(value);
}

function formatUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  if (fraction === 0n) return whole.toString();
  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fractionText}`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${bodyText}`);
  }
  if (!bodyText) {
    throw new Error("Received empty response body");
  }
  return JSON.parse(bodyText) as T;
}

async function fetchEthereumRpcResult<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  };
  const response = await fetchJson<EthereumRpcResponse<T>>(rpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (response.error?.message) {
    throw new Error(`Ethereum RPC error: ${response.error.message}`);
  }
  if (response.result === undefined) {
    throw new Error(`Ethereum RPC did not return a result for ${method}`);
  }
  return response.result;
}

async function fetchCoinbaseBalances(baseUrl: string, includeZeroBalances: boolean): Promise<unknown> {
  const apiKey = readEnvValue("COINBASE_API_KEY");
  const apiSecret = readEnvValue("COINBASE_API_SECRET");
  const apiPassphrase = readEnvValue("COINBASE_API_PASSPHRASE");
  if (!apiKey || !apiSecret || !apiPassphrase) {
    throw new Error("Coinbase credentials are required. Set COINBASE_API_KEY, COINBASE_API_SECRET, and COINBASE_API_PASSPHRASE.");
  }

  const requestPath = "/accounts";
  const timestamp = (Date.now() / 1000).toString();
  const message = `${timestamp}GET${requestPath}`;
  const signature = createHmac("sha256", Buffer.from(apiSecret, "base64")).update(message).digest("base64");
  const url = `${normalizeBaseUrl(baseUrl)}${requestPath}`;
  const accounts = await fetchJson<CoinbaseAccount[]>(url, {
    method: "GET",
    headers: {
      "CB-ACCESS-KEY": apiKey,
      "CB-ACCESS-SIGN": signature,
      "CB-ACCESS-TIMESTAMP": timestamp,
      "CB-ACCESS-PASSPHRASE": apiPassphrase,
      "Content-Type": "application/json",
    },
  });

  const filtered = includeZeroBalances
    ? accounts
    : accounts.filter((account) => {
        const balance = Number.parseFloat(account.balance ?? "0");
        const hold = Number.parseFloat(account.hold ?? "0");
        const available = Number.parseFloat(account.available ?? "0");
        return balance !== 0 || hold !== 0 || available !== 0;
      });

  return {
    project: PAMELA_MENOPOOL_PROJECT,
    source: "coinbase",
    count: filtered.length,
    balances: filtered.map((account) => ({
      id: account.id,
      currency: account.currency,
      balance: account.balance,
      available: account.available,
      hold: account.hold,
      profileId: account.profile_id,
    })),
  };
}

async function fetchEthereumBalances(address: string, tokenContracts: string[], rpcUrl: string): Promise<unknown> {
  ensureHexAddress(address, "address");
  for (const tokenContract of tokenContracts) {
    ensureHexAddress(tokenContract, "token contract");
  }

  const balanceHex = await fetchEthereumRpcResult<string>(rpcUrl, "eth_getBalance", [address, "latest"]);
  const balanceWei = parseHexToBigInt(balanceHex, "eth_getBalance");

  const tokenBalances = [];
  for (const tokenContract of tokenContracts) {
    const addressData = address.slice(2).padStart(64, "0");
    const balanceOfData = `0x${ERC20_BALANCE_OF_SELECTOR}${addressData}`;
    const tokenBalanceHex = await fetchEthereumRpcResult<string>(rpcUrl, "eth_call", [{ to: tokenContract, data: balanceOfData }, "latest"]);
    const tokenBalanceRaw = parseHexToBigInt(tokenBalanceHex, "eth_call balanceOf");

    let decimals = 18;
    try {
      const decimalsHex = await fetchEthereumRpcResult<string>(rpcUrl, "eth_call", [{ to: tokenContract, data: `0x${ERC20_DECIMALS_SELECTOR}` }, "latest"]);
      decimals = Number.parseInt(decimalsHex, 16);
      if (!Number.isFinite(decimals) || decimals < 0 || decimals > 255) {
        decimals = 18;
      }
    } catch {
      decimals = 18;
    }

    tokenBalances.push({
      contract: tokenContract,
      balanceRaw: tokenBalanceRaw.toString(),
      balance: formatUnits(tokenBalanceRaw, decimals),
      decimals,
    });
  }

  return {
    project: PAMELA_MENOPOOL_PROJECT,
    source: "ethereum",
    address,
    eth: {
      wei: balanceWei.toString(),
      value: formatUnits(balanceWei, 18),
    },
    erc20Tokens: tokenBalances,
  };
}

async function fetchBitcoinBalance(address: string, apiBaseUrl: string, includeMempool: boolean): Promise<unknown> {
  if (!address || address.trim().length === 0) {
    throw new Error("address is required");
  }

  const url = `${normalizeBaseUrl(apiBaseUrl)}/address/${address}`;
  const response = await fetchJson<BitcoinAddressResponse>(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });

  const chainFunded = response.chain_stats?.funded_txo_sum ?? 0;
  const chainSpent = response.chain_stats?.spent_txo_sum ?? 0;
  const mempoolFunded = response.mempool_stats?.funded_txo_sum ?? 0;
  const mempoolSpent = response.mempool_stats?.spent_txo_sum ?? 0;

  const chainBalance = BigInt(chainFunded - chainSpent);
  const mempoolBalance = BigInt(mempoolFunded - mempoolSpent);
  const totalBalance = includeMempool ? chainBalance + mempoolBalance : chainBalance;

  return {
    project: PAMELA_MENOPOOL_PROJECT,
    source: "bitcoin",
    address,
    satoshis: totalBalance.toString(),
    value: formatUnits(totalBalance, 8),
    includeMempool,
  };
}

function configureCoinsTools(server: McpServer) {
  server.tool(
    COINS_TOOLS.get_coinbase_balance,
    "Get Coinbase account balances and holdings for the Pamela Menopool project setup.",
    {
      includeZeroBalances: z.boolean().optional().default(false).describe("When true, include Coinbase assets with a zero balance."),
      baseUrl: z.string().optional().describe("Optional Coinbase API base URL. Defaults to COINBASE_API_BASE_URL or https://api.exchange.coinbase.com."),
    },
    async ({ includeZeroBalances, baseUrl }) => {
      try {
        const result = await fetchCoinbaseBalances(baseUrl ?? readEnvValue("COINBASE_API_BASE_URL") ?? DEFAULT_COINBASE_BASE_URL, includeZeroBalances);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error fetching Coinbase balances: ${toErrorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    COINS_TOOLS.get_ethereum_balance,
    "Get ETH and optional ERC-20 token balances for an Ethereum address.",
    {
      address: z.string().describe("Ethereum address to query (0x-prefixed)."),
      tokenContracts: z.array(z.string()).optional().default([]).describe("Optional ERC-20 contract addresses to query using balanceOf."),
      rpcUrl: z.string().optional().describe("Optional Ethereum RPC URL. Defaults to ETHEREUM_RPC_URL or https://ethereum-rpc.publicnode.com."),
    },
    async ({ address, tokenContracts, rpcUrl }) => {
      try {
        const result = await fetchEthereumBalances(address, tokenContracts, rpcUrl ?? readEnvValue("ETHEREUM_RPC_URL") ?? DEFAULT_ETHEREUM_RPC_URL);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error fetching Ethereum balance: ${toErrorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    COINS_TOOLS.get_bitcoin_balance,
    "Get Bitcoin balance for an address using a public endpoint.",
    {
      address: z.string().describe("Bitcoin address to query."),
      includeMempool: z.boolean().optional().default(true).describe("When true, includes mempool deltas in the returned BTC balance."),
      apiBaseUrl: z.string().optional().describe("Optional Bitcoin API base URL. Defaults to BITCOIN_API_BASE_URL or https://blockstream.info/api."),
    },
    async ({ address, includeMempool, apiBaseUrl }) => {
      try {
        const result = await fetchBitcoinBalance(address, apiBaseUrl ?? readEnvValue("BITCOIN_API_BASE_URL") ?? DEFAULT_BITCOIN_API_BASE_URL, includeMempool);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error fetching Bitcoin balance: ${toErrorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    COINS_TOOLS.query_all_balances,
    "Aggregate Coinbase, Ethereum, and Bitcoin balances for Pamela Menopool workflows.",
    {
      includeCoinbase: z.boolean().optional().default(true).describe("When true, attempts to load Coinbase balances using configured credentials."),
      ethereumAddress: z.string().optional().describe("Ethereum address for ETH/ERC-20 balances."),
      ethereumTokenContracts: z.array(z.string()).optional().default([]).describe("Optional ERC-20 contract addresses to query for the Ethereum address."),
      bitcoinAddress: z.string().optional().describe("Bitcoin address for BTC balance."),
      includeBitcoinMempool: z.boolean().optional().default(true).describe("When true, includes mempool deltas in BTC balance."),
      coinbaseBaseUrl: z.string().optional().describe("Optional Coinbase base URL override."),
      ethereumRpcUrl: z.string().optional().describe("Optional Ethereum RPC URL override."),
      bitcoinApiBaseUrl: z.string().optional().describe("Optional Bitcoin API base URL override."),
      includeZeroCoinbaseBalances: z.boolean().optional().default(false).describe("When true, Coinbase zero balances are included."),
    },
    async ({ includeCoinbase, ethereumAddress, ethereumTokenContracts, bitcoinAddress, includeBitcoinMempool, coinbaseBaseUrl, ethereumRpcUrl, bitcoinApiBaseUrl, includeZeroCoinbaseBalances }) => {
      const sources: Record<string, unknown> = {};
      const errors: Record<string, string> = {};

      if (includeCoinbase) {
        try {
          sources.coinbase = await fetchCoinbaseBalances(coinbaseBaseUrl ?? readEnvValue("COINBASE_API_BASE_URL") ?? DEFAULT_COINBASE_BASE_URL, includeZeroCoinbaseBalances);
        } catch (error) {
          errors.coinbase = toErrorMessage(error);
        }
      }

      if (ethereumAddress) {
        try {
          sources.ethereum = await fetchEthereumBalances(ethereumAddress, ethereumTokenContracts, ethereumRpcUrl ?? readEnvValue("ETHEREUM_RPC_URL") ?? DEFAULT_ETHEREUM_RPC_URL);
        } catch (error) {
          errors.ethereum = toErrorMessage(error);
        }
      }

      if (bitcoinAddress) {
        try {
          sources.bitcoin = await fetchBitcoinBalance(bitcoinAddress, bitcoinApiBaseUrl ?? readEnvValue("BITCOIN_API_BASE_URL") ?? DEFAULT_BITCOIN_API_BASE_URL, includeBitcoinMempool);
        } catch (error) {
          errors.bitcoin = toErrorMessage(error);
        }
      }

      if (Object.keys(sources).length === 0 && Object.keys(errors).length > 0) {
        return {
          content: [{ type: "text", text: `Error fetching balances: ${JSON.stringify(errors, null, 2)}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                project: PAMELA_MENOPOOL_PROJECT,
                sources,
                errors,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    COINS_TOOLS.next_string_to_payout,
    "Generate a normalized payout instruction string for Pamela Menopool payout workflows.",
    {
      amount: z
        .string()
        .describe("Payout amount as a positive decimal string (e.g. 0.5, 100, 1234.56).")
        .refine((value) => isPositiveDecimalString(value), { message: "amount must be a positive decimal string" }),
      currency: z.string().min(1).describe("Asset or fiat symbol to payout (e.g. BTC, ETH, USDC, USD)."),
      recipient: z.string().min(1).describe("Recipient wallet address, account, or destination identifier."),
      network: z.string().optional().describe("Optional payout network or chain (e.g. bitcoin, ethereum, base)."),
      memo: z.string().optional().describe("Optional memo, note, or destination tag."),
      reference: z.string().optional().describe("Optional payout reference identifier."),
    },
    async ({ amount, currency, recipient, network, memo, reference }) => {
      try {
        const payoutStringParts: string[] = [];
        const encodedAmount = encodePayoutComponent(amount);
        const encodedCurrency = encodePayoutComponent(currency.toUpperCase());
        const encodedRecipient = encodePayoutComponent(recipient);
        payoutStringParts.push(`amount=${encodedAmount}`);
        payoutStringParts.push(`currency=${encodedCurrency}`);
        payoutStringParts.push(`recipient=${encodedRecipient}`);

        addOptionalPayoutComponent(payoutStringParts, "network", network);
        addOptionalPayoutComponent(payoutStringParts, "memo", memo);
        addOptionalPayoutComponent(payoutStringParts, "reference", reference);

        const payoutString = `PAYOUT|${payoutStringParts.join("|")}`;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  project: PAMELA_MENOPOOL_PROJECT,
                  source: "payout",
                  payoutString,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error creating payout string: ${toErrorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}

export { COINS_TOOLS, configureCoinsTools };

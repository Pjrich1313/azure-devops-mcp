// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, beforeEach, afterEach } from "@jest/globals";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { configureCoinsTools } from "../../../src/tools/coins";

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe("configureCoinsTools", () => {
  let server: McpServer;
  const originalEnv = process.env;

  beforeEach(() => {
    server = { tool: jest.fn() } as unknown as McpServer;
    global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function getHandler(toolName: string) {
    const call = (server.tool as jest.Mock).mock.calls.find(([name]) => name === toolName);
    if (!call) throw new Error(`${toolName} tool not registered`);
    return call[3] as (input: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  }

  it("registers coin tools", () => {
    configureCoinsTools(server);
    expect(server.tool).toHaveBeenCalledTimes(5);
  });

  it("get_coinbase_balance returns filtered balances", async () => {
    process.env.COINBASE_API_KEY = "test-key";
    process.env.COINBASE_API_SECRET = Buffer.from("test-secret").toString("base64");
    process.env.COINBASE_API_PASSPHRASE = "test-passphrase";

    (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(
      mockJsonResponse([
        { id: "a1", currency: "BTC", balance: "1.25", available: "1.00", hold: "0.25" },
        { id: "a2", currency: "ETH", balance: "0", available: "0", hold: "0" },
      ])
    );

    configureCoinsTools(server);
    const handler = getHandler("get_coinbase_balance");
    const result = await handler({ includeZeroBalances: false, baseUrl: "https://api.exchange.coinbase.com" });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.source).toBe("coinbase");
    expect(payload.count).toBe(1);
    expect(payload.balances[0].currency).toBe("BTC");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.exchange.coinbase.com/accounts",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "CB-ACCESS-KEY": "test-key",
          "CB-ACCESS-PASSPHRASE": "test-passphrase",
        }),
      })
    );
  });

  it("get_ethereum_balance returns ETH and ERC-20 balances", async () => {
    (global.fetch as jest.MockedFunction<typeof fetch>)
      .mockResolvedValueOnce(mockJsonResponse({ result: "0xde0b6b3a7640000" }))
      .mockResolvedValueOnce(mockJsonResponse({ result: "0x0de0b6b3a7640000" }))
      .mockResolvedValueOnce(mockJsonResponse({ result: "0x12" }));

    configureCoinsTools(server);
    const handler = getHandler("get_ethereum_balance");
    const address = "0x1111111111111111111111111111111111111111";
    const token = "0x2222222222222222222222222222222222222222";
    const result = await handler({ address, tokenContracts: [token], rpcUrl: "https://eth.example" });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.source).toBe("ethereum");
    expect(payload.eth.value).toBe("1");
    expect(payload.erc20Tokens[0]).toEqual(
      expect.objectContaining({
        contract: token,
        balance: "1",
        decimals: 18,
      })
    );
  });

  it("get_bitcoin_balance returns BTC from satoshi values", async () => {
    (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce(
      mockJsonResponse({
        chain_stats: { funded_txo_sum: 200000000, spent_txo_sum: 50000000 },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
      })
    );

    configureCoinsTools(server);
    const handler = getHandler("get_bitcoin_balance");
    const result = await handler({ address: "bc1qtest123", includeMempool: true, apiBaseUrl: "https://btc.example/api" });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.source).toBe("bitcoin");
    expect(payload.satoshis).toBe("150000000");
    expect(payload.value).toBe("1.5");
  });

  it("query_all_balances aggregates all configured sources", async () => {
    process.env.COINBASE_API_KEY = "test-key";
    process.env.COINBASE_API_SECRET = Buffer.from("test-secret").toString("base64");
    process.env.COINBASE_API_PASSPHRASE = "test-passphrase";

    (global.fetch as jest.MockedFunction<typeof fetch>)
      .mockResolvedValueOnce(mockJsonResponse([{ id: "a1", currency: "BTC", balance: "1", available: "1", hold: "0" }]))
      .mockResolvedValueOnce(mockJsonResponse({ result: "0x1bc16d674ec80000" }))
      .mockResolvedValueOnce(
        mockJsonResponse({
          chain_stats: { funded_txo_sum: 100000000, spent_txo_sum: 0 },
          mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
        })
      );

    configureCoinsTools(server);
    const handler = getHandler("query_all_balances");
    const result = await handler({
      includeCoinbase: true,
      ethereumAddress: "0x1111111111111111111111111111111111111111",
      ethereumTokenContracts: [],
      bitcoinAddress: "bc1qtest123",
      includeBitcoinMempool: true,
      coinbaseBaseUrl: "https://api.exchange.coinbase.com",
      ethereumRpcUrl: "https://eth.example",
      bitcoinApiBaseUrl: "https://btc.example/api",
      includeZeroCoinbaseBalances: false,
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.project).toBe("Pamela Menopool");
    expect(payload.sources.coinbase.source).toBe("coinbase");
    expect(payload.sources.ethereum.source).toBe("ethereum");
    expect(payload.sources.bitcoin.source).toBe("bitcoin");
    expect(payload.errors).toEqual({});
  });

  it("next_string_to_payout creates a normalized payout string", async () => {
    configureCoinsTools(server);
    const handler = getHandler("next_string_to_payout");
    const result = await handler({
      amount: "12.34",
      currency: "usdc",
      recipient: "0xabc123",
      network: "base",
      memo: "invoice 42",
      reference: "pay-001",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.project).toBe("Pamela Menopool");
    expect(payload.source).toBe("payout");
    expect(payload.payoutString).toBe("PAYOUT|amount=12.34|currency=USDC|recipient=0xabc123|network=base|memo=invoice%2042|reference=pay-001");
  });

  it("next_string_to_payout omits optional fields when not provided", async () => {
    configureCoinsTools(server);
    const handler = getHandler("next_string_to_payout");
    const result = await handler({
      amount: "1",
      currency: "btc",
      recipient: "bc1qrecipient",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.payoutString).toBe("PAYOUT|amount=1|currency=BTC|recipient=bc1qrecipient");
  });

  it("next_string_to_payout url-encodes special characters", async () => {
    configureCoinsTools(server);
    const handler = getHandler("next_string_to_payout");
    const result = await handler({
      amount: "2.5",
      currency: "usd",
      recipient: "account|name?x=1",
      memo: "memo/value #1",
      reference: "ref:abc/123",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.payoutString).toBe("PAYOUT|amount=2.5|currency=USD|recipient=account%7Cname%3Fx%3D1|memo=memo%2Fvalue%20%231|reference=ref%3Aabc%2F123");
  });
});

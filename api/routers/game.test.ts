import { describe, it, expect } from "vitest";
import { gameRouter } from "./game";
import { balanceRouter } from "./balance";
import { jackpotRouter } from "./jackpot";

describe("Execution Trace Map & Router Verification", () => {
  it("should validate gameRouter, balanceRouter, and jackpotRouter procedure definitions", () => {
    expect(gameRouter).toBeDefined();
    expect(gameRouter._def.procedures.startSession).toBeDefined();
    expect(gameRouter._def.procedures.spin).toBeDefined();

    expect(balanceRouter).toBeDefined();
    expect(balanceRouter._def.procedures.get).toBeDefined();

    expect(jackpotRouter).toBeDefined();
    expect(jackpotRouter._def.procedures.getPools).toBeDefined();
  });
});

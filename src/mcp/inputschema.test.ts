/**
 * Every MCP tool's inputSchema must be an inline JSON Schema with
 * type:"object". Passing a `name` to zodToJsonSchema wraps it in a
 * $ref/definitions envelope (no top-level type) which MCP clients reject
 * with "expected object" — this guards that regression.
 */
import { describe, it, expect } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  getWalletInput, getBalanceInput, getHoldingsInput,
  privateBuyInput, cashoutInput, privateLendInput, discoverLeadersInput,
} from "./schemas.js";

const schemas = {
  getWalletInput, getBalanceInput, getHoldingsInput,
  privateBuyInput, cashoutInput, privateLendInput, discoverLeadersInput,
};

describe("MCP tool inputSchema", () => {
  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name} serializes to a JSON Schema with type:"object"`, () => {
      const js = zodToJsonSchema(schema) as { type?: string; $ref?: string };
      expect(js.$ref).toBeUndefined();   // no $ref envelope
      expect(js.type).toBe("object");
    });
  }
});

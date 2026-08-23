import { describe, expect, it } from "vitest";
import { COMMON_ZONES, isValidZone } from "./timezonePicker.js";

describe("timezone picker", () => {
  it("offers at most 25 zones, Discord's select limit", () => {
    expect(COMMON_ZONES.length).toBeLessThanOrEqual(25);
    expect(COMMON_ZONES.length).toBeGreaterThan(5);
  });

  it("offers only valid IANA zones", () => {
    expect(COMMON_ZONES.every((z) => isValidZone(z.value))).toBe(true);
  });

  it("accepts a valid IANA zone", () => {
    expect(isValidZone("Europe/London")).toBe(true);
  });

  it("rejects an abbreviation, which is ambiguous", () => {
    expect(isValidZone("EST5EDT_not_real")).toBe(false);
  });

  it("rejects nonsense without throwing", () => {
    expect(isValidZone("Mars/Olympus")).toBe(false);
  });
});

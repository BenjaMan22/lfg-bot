import { describe, expect, it } from "vitest";
import {
  COMMON_ZONES,
  isValidZone,
  timezonePrompt,
  timezoneSetReply,
} from "./timezonePicker.js";

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

describe("carrying on after the timezone is set", () => {
  // The builders serialise through toJSON, so the ids can be read off the JSON.
  const ids = (prompt: ReturnType<typeof timezonePrompt>) =>
    [...JSON.stringify(prompt.components).matchAll(/"custom_id":"([^"]+)"/g)].map((m) => m[1]);

  it("remembers what the person was doing in the picker's ids", () => {
    expect(ids(timezonePrompt("Need it", "avail:6"))).toEqual([
      "gn:tz:avail:6",
      "gn:tzother:avail:6",
    ]);
  });

  it("keeps the plain ids when there is nothing to carry on to", () => {
    expect(ids(timezonePrompt("Need it"))).toEqual(["gn:tz", "gn:tzother"]);
  });

  it("confirms the zone and goes straight on to the next step", () => {
    const next = { content: "Pick the half-hour blocks you are free.", components: [] };
    expect(timezoneSetReply("America/New_York", next).content).toBe(
      "Timezone set to **America/New_York**.\n\nPick the half-hour blocks you are free.",
    );
  });

  it("asks to run it again when there is no next step", () => {
    expect(timezoneSetReply("America/New_York").content).toMatch(/run the command again/);
  });
});

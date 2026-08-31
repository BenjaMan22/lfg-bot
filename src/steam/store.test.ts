import { describe, expect, it } from "vitest";
import {
  decodeGamePick,
  encodeGamePick,
  parseSearchResults,
  searchSteam,
  steamStoreUrl,
  MAX_SUGGESTIONS,
} from "./store.js";

describe("steamStoreUrl", () => {
  it("builds a store link from an appid", () => {
    expect(steamStoreUrl(620)).toBe("https://store.steampowered.com/app/620/");
  });
});

describe("parseSearchResults", () => {
  const body = {
    total: 2,
    items: [
      { type: "app", name: "Portal 2", id: 620 },
      { type: "app", name: "Deep Rock Galactic", id: 548430 },
    ],
  };

  it("keeps the appid and name of each hit", () => {
    expect(parseSearchResults(body)).toEqual([
      { appid: 620, name: "Portal 2" },
      { appid: 548430, name: "Deep Rock Galactic" },
    ]);
  });

  it("returns nothing for a shape it does not recognise", () => {
    expect(parseSearchResults(null)).toEqual([]);
    expect(parseSearchResults({})).toEqual([]);
    expect(parseSearchResults({ items: "nope" })).toEqual([]);
  });

  it("skips entries missing an id or a name", () => {
    const partial = { items: [{ type: "app", name: "No Id" }, { type: "app", id: 5 }] };
    expect(parseSearchResults(partial)).toEqual([]);
  });

  it("never returns more than Discord will accept", () => {
    const many = {
      items: Array.from({ length: 40 }, (_, i) => ({ type: "app", name: `G${i}`, id: i + 1 })),
    };
    expect(parseSearchResults(many)).toHaveLength(MAX_SUGGESTIONS);
  });
});

describe("game pick encoding", () => {
  const portal = { appid: 620, name: "Portal 2" };

  it("round-trips a Steam pick with its name", () => {
    expect(decodeGamePick(encodeGamePick(portal))).toEqual({
      kind: "steam",
      appid: 620,
      name: "Portal 2",
    });
  });

  it("stays inside Discord's 100-character option value limit", () => {
    const long = { appid: 9999999, name: "G".repeat(200) };
    expect(encodeGamePick(long).length).toBeLessThanOrEqual(100);
  });

  it("keeps a name containing colons intact", () => {
    const sub = { appid: 42, name: "Half-Life: Alyx" };
    expect(decodeGamePick(encodeGamePick(sub))).toEqual({
      kind: "steam",
      appid: 42,
      name: "Half-Life: Alyx",
    });
  });

  it("treats anything else as a plain typed name", () => {
    expect(decodeGamePick("Werewolf")).toEqual({ kind: "name", name: "Werewolf" });
  });

  it("does not mistake a name that merely mentions steam for a pick", () => {
    expect(decodeGamePick("steam:not-a-number")).toEqual({
      kind: "name",
      name: "steam:not-a-number",
    });
  });
});

describe("searchSteam", () => {
  const ok = (body: unknown) =>
    (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

  it("returns the parsed hits for a successful search", async () => {
    const fetchImpl = ok({ items: [{ type: "app", name: "Portal 2", id: 620 }] });
    expect(await searchSteam("portal", fetchImpl)).toEqual([{ appid: 620, name: "Portal 2" }]);
  });

  it("sends the query url-encoded", async () => {
    let seen = "";
    const fetchImpl = (async (url: string) => {
      seen = url;
      return { ok: true, json: async () => ({ items: [] }) };
    }) as unknown as typeof fetch;
    await searchSteam("deep rock & friends", fetchImpl);
    expect(seen).toContain("term=deep%20rock%20%26%20friends");
  });

  it("suggests nothing rather than throwing when Steam is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(searchSteam("portal", fetchImpl)).resolves.toEqual([]);
  });

  it("suggests nothing on a non-200 response", async () => {
    const fetchImpl = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await searchSteam("portal", fetchImpl)).toEqual([]);
  });

  it("suggests nothing on malformed JSON", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    })) as unknown as typeof fetch;
    expect(await searchSteam("portal", fetchImpl)).toEqual([]);
  });

  it("does not call Steam at all for an empty query", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return { ok: true, json: async () => ({ items: [] }) };
    }) as unknown as typeof fetch;
    expect(await searchSteam("   ", fetchImpl)).toEqual([]);
    expect(calls).toBe(0);
  });
});

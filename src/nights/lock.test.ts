import { describe, expect, it } from "vitest";
import { shouldGiveUp } from "./lock.js";

const HOUR = 3600;
const GRACE = 30 * 60;

/**
 * shouldGiveUp anchors the retry grace window to whichever is later: the
 * night's own deadline, or processStartUtc (when the sweep first attempted
 * this night). This is the fix for a bug where the boot-time catch-up pass
 * in startSweep — which runs immediately on ClientReady to handle anything
 * that came due while the bot was offline — anchored solely to deadlineUtc.
 * If the bot was down past a night's deadline for longer than the grace
 * window, that first catch-up attempt already had nowUtc > deadlineUtc +
 * grace, so a single infrastructure hiccup permanently failed a night with
 * zero retries, even though the sweep had only just seen it.
 */
describe("shouldGiveUp", () => {
  it("keeps retrying while well inside the grace window", () => {
    const deadlineUtc = 1_000_000 * HOUR;
    const processStartUtc = deadlineUtc; // bot was already running
    const nowUtc = deadlineUtc + 5 * 60; // 5 minutes past deadline
    expect(shouldGiveUp(deadlineUtc, processStartUtc, nowUtc, GRACE)).toBe(false);
  });

  it("gives up just past the grace window when the bot was already running", () => {
    const deadlineUtc = 1_000_000 * HOUR;
    const processStartUtc = deadlineUtc; // sweep saw this night right at deadline
    const nowUtc = deadlineUtc + GRACE + 1;
    expect(shouldGiveUp(deadlineUtc, processStartUtc, nowUtc, GRACE)).toBe(true);
  });

  it("still retries past deadline+grace when the sweep just booted (the bug)", () => {
    const deadlineUtc = 1_000_000 * HOUR;
    // Bot was down well past the deadline; the boot catch-up pass only just
    // started seeing this night now.
    const processStartUtc = deadlineUtc + 2 * HOUR;
    const nowUtc = processStartUtc + 1; // one second into the very first attempt
    expect(shouldGiveUp(deadlineUtc, processStartUtc, nowUtc, GRACE)).toBe(false);
  });

  it("still gives up eventually after a late boot, once its own grace window elapses", () => {
    const deadlineUtc = 1_000_000 * HOUR;
    const processStartUtc = deadlineUtc + 2 * HOUR;
    const nowUtc = processStartUtc + GRACE + 1;
    expect(shouldGiveUp(deadlineUtc, processStartUtc, nowUtc, GRACE)).toBe(true);
  });

  it("does not give up exactly at the boundary (matches existing strict >)", () => {
    const deadlineUtc = 1_000_000 * HOUR;
    const processStartUtc = deadlineUtc + 2 * HOUR;
    const anchor = Math.max(deadlineUtc, processStartUtc);
    const nowUtc = anchor + GRACE; // exactly on the boundary
    expect(shouldGiveUp(deadlineUtc, processStartUtc, nowUtc, GRACE)).toBe(false);
    expect(shouldGiveUp(deadlineUtc, processStartUtc, nowUtc + 1, GRACE)).toBe(true);
  });
});

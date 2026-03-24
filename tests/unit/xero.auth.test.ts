import { describe, test, expect } from "vitest";
import {
  createOAuthState,
  verifyOAuthState,
  generateAuthUrl,
} from "../../src/modules/xero/xero.auth.js";

describe("OAuth state signing", () => {
  test("creates a non-empty state string", () => {
    const state = createOAuthState();
    expect(typeof state).toBe("string");
    expect(state.length).toBeGreaterThan(20);
  });

  test("verifies a freshly created state", () => {
    const state = createOAuthState();
    expect(verifyOAuthState(state)).toBe(true);
  });

  test("each call produces a unique state", () => {
    const a = createOAuthState();
    const b = createOAuthState();
    expect(a).not.toBe(b);
  });

  test("rejects a tampered state", () => {
    const state = createOAuthState();
    expect(verifyOAuthState(state + "x")).toBe(false);
  });

  test("rejects arbitrary strings", () => {
    expect(verifyOAuthState("test123")).toBe(false);
    expect(verifyOAuthState("")).toBe(false);
    expect(verifyOAuthState("aaaa.bbbb")).toBe(false);
  });

  test("rejects state with truncated HMAC", () => {
    const state = createOAuthState();
    expect(verifyOAuthState(state.slice(0, -4))).toBe(false);
  });
});

describe("generateAuthUrl", () => {
  test("points to Xero authorization endpoint", () => {
    const url = generateAuthUrl("somestate");
    expect(url).toContain("https://login.xero.com/identity/connect/authorize");
  });

  test("includes all required OAuth2 parameters", () => {
    const state = createOAuthState();
    const url = generateAuthUrl(state);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBeTruthy();
    expect(parsed.searchParams.get("redirect_uri")).toBeTruthy();
    expect(parsed.searchParams.get("scope")).toBeTruthy();
    expect(parsed.searchParams.get("state")).toBe(state);
  });

  test("scope includes offline_access for refresh tokens", () => {
    const url = generateAuthUrl("state");
    expect(url).toContain("offline_access");
  });

  test("scope does not include deprecated accounting.transactions", () => {
    const url = generateAuthUrl("state");
    // This scope is invalid for apps created after March 2026
    expect(url).not.toContain("accounting.transactions");
  });
});

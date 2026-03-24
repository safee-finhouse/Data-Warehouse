import { describe, test, expect } from "vitest";
import { parseXeroDate } from "../../src/modules/xero/xero.api.js";

describe("parseXeroDate", () => {
  test("parses .NET /Date(timestamp)/ format", () => {
    // 2021-01-01T00:00:00.000Z
    const date = parseXeroDate("/Date(1609459200000+0000)/");
    expect(date).toBeInstanceOf(Date);
    expect(date?.getFullYear()).toBe(2021);
  });

  test("parses .NET /Date(timestamp)/ without timezone", () => {
    const date = parseXeroDate("/Date(1609459200000)/");
    expect(date).toBeInstanceOf(Date);
  });

  test("parses ISO date string", () => {
    const date = parseXeroDate("2024-06-15T10:30:00");
    expect(date).toBeInstanceOf(Date);
    expect(date?.getFullYear()).toBe(2024);
    expect(date?.getMonth()).toBe(5); // June = 5
  });

  test("returns null for null", () => {
    expect(parseXeroDate(null)).toBeNull();
  });

  test("returns null for undefined", () => {
    expect(parseXeroDate(undefined)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseXeroDate("")).toBeNull();
  });

  test("returns null for unparseable string", () => {
    expect(parseXeroDate("not-a-date")).toBeNull();
  });

  test("preserves millisecond precision from timestamp", () => {
    const ts = 1700000000123;
    const date = parseXeroDate(`/Date(${ts}+0000)/`);
    expect(date?.getTime()).toBe(ts);
  });
});

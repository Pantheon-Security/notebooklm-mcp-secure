import { describe, expect, it } from "vitest";
import { AuthenticationError, RateLimitError } from "../src/errors.js";

describe("Custom Error Classes", () => {
  it("should create RateLimitError instances with the correct name and message", () => {
    const error = new RateLimitError("quota exceeded");

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AuthenticationError);
    expect(error.name).toBe("RateLimitError");
    expect(error.message).toBe("quota exceeded");
  });

  it("should create AuthenticationError instances with the correct name and message", () => {
    const error = new AuthenticationError("invalid credentials");

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RateLimitError);
    expect(error.name).toBe("AuthenticationError");
    expect(error.message).toBe("invalid credentials");
  });
});

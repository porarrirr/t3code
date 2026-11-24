import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { hasCloudPublicConfig } from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("hasCloudPublicConfig", () => {
  // Privacy build: T3 Connect is compiled out, so Connect is never configured,
  // whatever env vars or origins say.
  it.each(["https://example.com", "http://localhost:3773", "file:///app/index.html"])(
    "is always off in this privacy build: %s",
    (origin) => {
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_live_${btoa("clerk.example.com$")}`);
      vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
      vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
      vi.stubGlobal("window", { location: new URL(origin), desktopBridge: {} });

      expect(hasCloudPublicConfig()).toBe(false);
    },
  );

  it("stays off with no cloud config at all", () => {
    vi.stubGlobal("window", { location: new URL("https://example.com") });

    expect(hasCloudPublicConfig()).toBe(false);
  });
});

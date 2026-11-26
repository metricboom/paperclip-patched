import { describe, expect, it } from "vitest";
import {
  isConnectionGrantAudienceAllowed,
  resolveCredentialGrantKind,
} from "../services/tool-gateway.js";

describe("connection grant resolution", () => {
  it("resolves every credential policy deterministically", () => {
    expect(resolveCredentialGrantKind("shared", "alice", true)).toBe("organization");
    expect(resolveCredentialGrantKind("per_user", "alice", true)).toBe("user");
    expect(resolveCredentialGrantKind("per_user", "alice", false)).toBe("user_authorization_required");
    expect(resolveCredentialGrantKind("per_user", null, false)).toBe("user_authorization_required");
    expect(resolveCredentialGrantKind("per_user_with_fallback", "alice", true)).toBe("user");
    expect(resolveCredentialGrantKind("per_user_with_fallback", "alice", false)).toBe("organization");
    expect(resolveCredentialGrantKind("per_user_with_fallback", null, false)).toBe("organization");
  });

  it("allows an empty audience and rejects users outside a restricted audience", () => {
    expect(isConnectionGrantAudienceAllowed([], "alice", true)).toBe(true);
    expect(isConnectionGrantAudienceAllowed(["alice", "bob"], "alice", true)).toBe(true);
    expect(isConnectionGrantAudienceAllowed(["alice", "bob"], "carol", true)).toBe(false);
    expect(isConnectionGrantAudienceAllowed(["alice"], null, false)).toBe(false);
    expect(isConnectionGrantAudienceAllowed([], "alice", false)).toBe(false);
    expect(isConnectionGrantAudienceAllowed(["alice"], "alice", false)).toBe(false);
  });

  it("admits a run with no acting user only when its agent is an agent member", () => {
    const agents = { memberAgentIds: ["agent-x"] };
    expect(isConnectionGrantAudienceAllowed(["jamie"], null, false, { ...agents, actingAgentId: "agent-x" })).toBe(true);
    expect(isConnectionGrantAudienceAllowed(["jamie"], null, false, { ...agents, actingAgentId: "agent-y" })).toBe(false);
    expect(isConnectionGrantAudienceAllowed(["jamie"], null, false, { ...agents, actingAgentId: null })).toBe(false);
    expect(isConnectionGrantAudienceAllowed([], null, false, { ...agents, actingAgentId: "agent-x" })).toBe(true);
    expect(isConnectionGrantAudienceAllowed([], null, false, { ...agents, actingAgentId: "agent-y" })).toBe(false);
    // An audience of agents only is not "all members".
    expect(isConnectionGrantAudienceAllowed([], "jamie", true, agents)).toBe(false);
    // A run with an acting user keeps the user check, agent membership aside.
    expect(isConnectionGrantAudienceAllowed(["jamie"], "jamie", true, { ...agents, actingAgentId: "agent-y" })).toBe(true);
    expect(isConnectionGrantAudienceAllowed(["jamie"], "carol", true, { ...agents, actingAgentId: "agent-x" })).toBe(false);
    expect(isConnectionGrantAudienceAllowed(["jamie"], "jamie", false, { ...agents, actingAgentId: "agent-x" })).toBe(false);
    // Both lists empty is everyone.
    expect(isConnectionGrantAudienceAllowed([], null, false, { memberAgentIds: [], actingAgentId: "agent-y" })).toBe(true);
  });
});

/**
 * Organization grant audience rule shared by the tool gateway, the token
 * broker, and repository browsing.
 *
 * - An audience with no user members and no agent members means "every
 *   organization member" (and every agent run).
 * - A run with an acting user is checked by user membership only: the user
 *   must be an active company member and, when the audience is restricted, a
 *   listed user member.
 * - A run with no acting user is admitted on a restricted audience only when
 *   its agent is a listed agent member.
 */
export function isConnectionGrantAudienceAllowed(
  memberUserIds: readonly string[],
  actingUserId: string | null,
  actingUserIsActiveMember: boolean,
  agentAudience: { memberAgentIds?: readonly string[]; actingAgentId?: string | null } = {},
): boolean {
  if (actingUserId !== null && !actingUserIsActiveMember) return false;
  const memberAgentIds = agentAudience.memberAgentIds ?? [];
  if (memberUserIds.length === 0 && memberAgentIds.length === 0) return true;
  if (actingUserId !== null) return memberUserIds.includes(actingUserId);
  const actingAgentId = agentAudience.actingAgentId ?? null;
  return actingAgentId !== null && memberAgentIds.includes(actingAgentId);
}

/** Splits stored audience rows into user and agent member ids. */
export function splitConnectionGrantAudience(
  rows: ReadonlyArray<{ subjectType: string; subjectId: string }>,
): { memberUserIds: string[]; memberAgentIds: string[] } {
  const memberUserIds: string[] = [];
  const memberAgentIds: string[] = [];
  for (const row of rows) {
    if (row.subjectType === "user") memberUserIds.push(row.subjectId);
    else if (row.subjectType === "agent") memberAgentIds.push(row.subjectId);
  }
  return { memberUserIds, memberAgentIds };
}

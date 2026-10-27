export interface VerifiedTeamsIdentity {
  entraId: string;
  displayName: string;
  email?: string;
}

/**
 * Resolve caller identity from gateway-trusted headers / Bot Framework claims.
 * Never trust Adaptive Card `data.approver` fields alone.
 */
export function verifyTeamsIdentity(headers: Record<string, string | string[] | undefined>): VerifiedTeamsIdentity {
  const entraId = headerValue(headers['x-hyperloop-entra-id']) ?? headerValue(headers['x-ms-client-principal-id']);
  const displayName =
    headerValue(headers['x-hyperloop-entra-name']) ??
    headerValue(headers['x-ms-client-principal-name']) ??
    'Teams User';

  if (!entraId) {
    throw new Error('Missing verified Entra identity');
  }

  return {
    entraId,
    displayName,
    email: headerValue(headers['x-hyperloop-entra-email']),
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

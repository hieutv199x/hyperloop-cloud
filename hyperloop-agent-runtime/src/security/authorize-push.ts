export type AuthorizePushResult = 'allowed' | 'denied';

export type AuthorizePushClient = (input: {
  executionId: string;
  fenceToken: string;
}) => Promise<AuthorizePushResult>;

/**
 * HTTP client for Control Plane `POST /executions/:id/authorize-push`.
 * Agents call this immediately before git push (v1.3 fencing).
 */
export function createHttpAuthorizePushClient(baseUrl: string): AuthorizePushClient {
  return async (input) => {
    const response = await fetch(
      `${baseUrl.replace(/\/$/, '')}/executions/${encodeURIComponent(input.executionId)}/authorize-push`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fenceToken: input.fenceToken }),
      },
    );
    if (response.status === 200) return 'allowed';
    return 'denied';
  };
}

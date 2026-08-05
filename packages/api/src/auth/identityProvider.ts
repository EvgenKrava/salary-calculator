import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';

/**
 * Creating and disabling logins, behind an interface.
 *
 * Injected rather than called directly so the invite flow is testable without AWS — the same
 * pattern the extraction handler uses for S3/Bedrock. Every method is scoped to what employee
 * onboarding needs; this is deliberately not a general Cognito wrapper.
 */
export interface IdentityProvider {
  /**
   * Create a login and put the user in `group`. Returns the Cognito `sub`, which is the only
   * durable identifier — an email can be changed, so `sub` is what employees are linked by.
   *
   * Throws `LoginExistsError` when the email is already taken, so the caller can map it to a
   * 409 rather than leaking an AWS exception name.
   */
  createUser(input: { email: string; group: string }): Promise<{ sub: string }>;
  /** Sign-in blocked, record kept. Used when an employee is deactivated. */
  disableUser(sub: string): Promise<void>;
  /** Re-allow sign-in for a previously disabled user. */
  enableUser(sub: string): Promise<void>;
  /** Move a user between role groups. */
  setGroup(input: { sub: string; from: string; to: string }): Promise<void>;
  /**
   * Delete a login outright. Only used to roll back a half-finished invite — see
   * `employees.ts`; a deactivated employee is disabled, never deleted, so history survives.
   */
  deleteUser(sub: string): Promise<void>;
}

/** The email already has a login. Mapped to 409 by the route. */
export class LoginExistsError extends Error {
  constructor(email: string) {
    super(`a login already exists for ${email}`);
    this.name = 'LoginExistsError';
  }
}

export interface CognitoConfig {
  region: string;
  userPoolId: string;
}

export function createCognitoIdentityProvider(config: CognitoConfig): IdentityProvider {
  const client = new CognitoIdentityProviderClient({ region: config.region });
  const UserPoolId = config.userPoolId;

  return {
    async createUser({ email, group }) {
      let created;
      try {
        created = await client.send(
          new AdminCreateUserCommand({
            UserPoolId,
            Username: email,
            UserAttributes: [
              { Name: 'email', Value: email },
              // The pool auto-verifies email, but the attribute must be set explicitly or
              // the user lands in FORCE_CHANGE_PASSWORD with an unverified address and
              // cannot use password recovery.
              { Name: 'email_verified', Value: 'true' },
            ],
            // Cognito generates and emails a temporary password. Suppressing the email would
            // leave the manager with no way to tell the employee how to sign in.
            DesiredDeliveryMediums: ['EMAIL'],
          }),
        );
      } catch (err) {
        if (err instanceof UsernameExistsException) throw new LoginExistsError(email);
        throw err;
      }

      const sub = created.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
      if (!sub) {
        // Should not happen — Cognito always returns sub. If it ever does, fail loudly rather
        // than writing an employee row with no usable link to its login.
        throw new Error('Cognito did not return a sub for the created user');
      }

      // Group assignment is a second call; the route rolls the user back if this throws, so a
      // login without a role can never be left behind (it would authenticate and then 403 on
      // every request, with no UI to repair it).
      await client.send(
        new AdminAddUserToGroupCommand({ UserPoolId, Username: sub, GroupName: group }),
      );

      return { sub };
    },

    async disableUser(sub) {
      await client.send(new AdminDisableUserCommand({ UserPoolId, Username: sub }));
    },

    async enableUser(sub) {
      await client.send(new AdminEnableUserCommand({ UserPoolId, Username: sub }));
    },

    async setGroup({ sub, from, to }) {
      if (from === to) return;
      // Add before remove: if the add fails the user keeps their old role, rather than being
      // left with none.
      await client.send(
        new AdminAddUserToGroupCommand({ UserPoolId, Username: sub, GroupName: to }),
      );
      await client.send(
        new AdminRemoveUserFromGroupCommand({ UserPoolId, Username: sub, GroupName: from }),
      );
    },

    async deleteUser(sub) {
      await client.send(new AdminDeleteUserCommand({ UserPoolId, Username: sub }));
    },
  };
}

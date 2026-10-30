import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import AuthManager from './auth.js';
import logger from './logger.js';
import { getRequestTokens } from './request-context.js';

type LoginTestResult = Awaited<ReturnType<AuthManager['testLogin']>>;

export const LOGIN_FAILED_HINT =
  'Sign-in finished but the connection check against Microsoft Graph failed. ' +
  'Sign in again (--login, or the login tool with force: true) using the expected Microsoft account. ' +
  'If it still fails, check network access to Microsoft Graph and that the app registration grants ' +
  'the requested permissions, then run --verify-login.';

/**
 * CLI `--login`: sign in, check the token against Graph, print the result and
 * return the process exit code — 0 only when testLogin passes.
 */
export async function runCliLogin(authManager: AuthManager, authBrowser: boolean): Promise<number> {
  if (authBrowser) {
    await authManager.acquireTokenInteractive();
  } else {
    await authManager.acquireTokenByDeviceCode();
  }
  logger.info('Login completed, testing connection with Graph API...');
  const result: LoginTestResult = await authManager.testLogin();
  if (!result.success) {
    console.error(`Login failed: ${result.message}\n${LOGIN_FAILED_HINT}`);
    console.log(JSON.stringify({ ...result, hint: LOGIN_FAILED_HINT }));
    return 1;
  }
  console.log(JSON.stringify(result));
  return 0;
}

export function registerAuthTools(server: McpServer, authManager: AuthManager): void {
  server.tool(
    'login',
    'Authenticate with Microsoft account',
    {
      force: z.boolean().default(false).describe('Force a new login even if already logged in'),
    },
    async ({ force }) => {
      try {
        if (!force) {
          const loginStatus = await authManager.testLogin();
          if (loginStatus.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'Already logged in',
                    ...loginStatus,
                  }),
                },
              ],
            };
          }
        }

        if (authManager.getUseInteractiveAuth()) {
          await authManager.acquireTokenInteractive();
          const loginResult = await authManager.testLogin();
          if (!loginResult.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'Login failed',
                    ...loginResult,
                    hint: LOGIN_FAILED_HINT,
                  }),
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'Login successful',
                  ...loginResult,
                }),
              },
            ],
          };
        }

        const text = await new Promise<string>((resolve, reject) => {
          authManager.acquireTokenByDeviceCode(resolve).catch(reject);
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'device_code_required',
                message: text.trim(),
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Authentication failed: ${(error as Error).message}` }),
            },
          ],
        };
      }
    }
  );

  server.tool('logout', 'Log out from Microsoft account', {}, async () => {
    try {
      await authManager.logout();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ message: 'Logged out successfully' }),
          },
        ],
      };
    } catch {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'Logout failed' }),
          },
        ],
      };
    }
  });

  server.tool('verify-login', 'Check current Microsoft authentication status', {}, async () => {
    let testResult: LoginTestResult;
    try {
      testResult = await authManager.testLogin();
    } catch (error) {
      testResult = {
        success: false,
        message: `Login failed: ${(error as Error).message}`,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(testResult),
        },
      ],
    };
  });

  server.tool(
    'list-accounts',
    'List all Microsoft accounts configured in this server. Use this to discover available account emails before making tool calls. Reflects accounts added mid-session via --login.',
    {},
    {
      title: 'list-accounts',
      readOnlyHint: true,
      openWorldHint: false,
    },
    async () => {
      try {
        const accounts = await authManager.listAccounts();
        const selectedAccountId = authManager.getSelectedAccountId();
        const pinnedMode = authManager.hasExpectedAccount();
        // OAuth bearer requests always use the connecting client's identity, so
        // cached accounts are not reachable via the account parameter (discussion #467).
        const oauthBearerMode = authManager.isOAuthModeEnabled() || Boolean(getRequestTokens());
        const result = accounts.map((account) => ({
          email: account.username || 'unknown',
          name: account.name,
          isDefault: account.homeAccountId === selectedAccountId,
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                accounts: result,
                count: result.length,
                tip: pinnedMode
                  ? 'Expected account pinning is configured; account parameters are disabled.'
                  : oauthBearerMode
                    ? "This server is in HTTP/OAuth mode: every request uses the identity of the connecting client's bearer token. The cached accounts listed here cannot be targeted via the 'account' parameter; reconnect the MCP client as the desired account instead."
                    : "Pass the 'email' value as the 'account' parameter in any tool call to target a specific account.",
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `Failed to list accounts: ${(error as Error).message}`,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'select-account',
    'Select a Microsoft account as the default. Accepts email address (e.g. user@outlook.com) or account ID. Use list-accounts to discover available accounts.',
    {
      account: z.string().describe('Email address or account ID of the account to select'),
    },
    async ({ account }) => {
      try {
        await authManager.selectAccount(account);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ message: `Selected account: ${account}` }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `Failed to select account: ${(error as Error).message}`,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'remove-account',
    'Remove a Microsoft account from the cache. Accepts email address (e.g. user@outlook.com) or account ID. Use list-accounts to discover available accounts.',
    {
      account: z.string().describe('Email address or account ID of the account to remove'),
    },
    async ({ account }) => {
      try {
        const success = await authManager.removeAccount(account);
        if (success) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ message: `Removed account: ${account}` }),
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `Failed to remove account from cache: ${account}` }),
              },
            ],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `Failed to remove account: ${(error as Error).message}`,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}

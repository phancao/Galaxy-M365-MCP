import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_FAILED_HINT, registerAuthTools, runCliLogin } from '../src/auth-tools.js';

vi.mock('zod', () => {
  const mockZod = {
    boolean: () => ({
      default: () => ({
        describe: () => 'mocked-zod-boolean',
      }),
    }),
    string: () => ({
      describe: () => 'mocked-zod-string',
    }),
    object: () => ({
      strict: () => 'mocked-zod-object',
    }),
  };
  return { z: mockZod };
});

describe('Auth Tools', () => {
  let server: { tool: ReturnType<typeof vi.fn> };
  let authManager: {
    logout: ReturnType<typeof vi.fn>;
    testLogin: ReturnType<typeof vi.fn>;
    acquireTokenByDeviceCode: ReturnType<typeof vi.fn>;
    getUseInteractiveAuth: ReturnType<typeof vi.fn>;
    acquireTokenInteractive: ReturnType<typeof vi.fn>;
    hasExpectedAccount: ReturnType<typeof vi.fn>;
  };
  let loginTool: ReturnType<typeof vi.fn>;
  let verifyLoginTool: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    loginTool = vi.fn();
    verifyLoginTool = vi.fn();

    server = {
      tool: vi.fn((name, description, schema, handler) => {
        if (name === 'login') {
          loginTool = handler;
        }
        if (name === 'verify-login') {
          verifyLoginTool = handler;
        }
      }),
    };

    authManager = {
      testLogin: vi.fn(),
      acquireTokenByDeviceCode: vi.fn(),
      getUseInteractiveAuth: vi.fn().mockReturnValue(false),
      acquireTokenInteractive: vi.fn().mockResolvedValue(undefined),
      hasExpectedAccount: vi.fn().mockReturnValue(false),
    };

    registerAuthTools(server, authManager);
  });

  describe('login tool', () => {
    it('should check if already logged in when force=false', async () => {
      authManager.testLogin.mockResolvedValue({
        success: true,
        userData: { displayName: 'Test User' },
      });

      const result = await loginTool({ force: false });

      expect(authManager.testLogin).toHaveBeenCalled();
      expect(authManager.acquireTokenByDeviceCode).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('Already logged in');
    });

    it('should force login when force=true even if already logged in', async () => {
      authManager.testLogin.mockResolvedValue({
        success: true,
        userData: { displayName: 'Test User' },
      });

      authManager.acquireTokenByDeviceCode.mockImplementation(
        (callback: (text: string) => void) => {
          callback('Login instructions');
          return Promise.resolve();
        }
      );

      const result = await loginTool({ force: true });

      expect(authManager.testLogin).not.toHaveBeenCalled();
      expect(authManager.acquireTokenByDeviceCode).toHaveBeenCalled();
      expect(result.content[0].text).toBe(
        JSON.stringify({
          error: 'device_code_required',
          message: 'Login instructions',
        })
      );
    });

    it('should use interactive browser auth when authBrowser mode is enabled', async () => {
      authManager.getUseInteractiveAuth.mockReturnValue(true);
      authManager.testLogin
        .mockResolvedValueOnce({ success: false, message: 'Not logged in' })
        .mockResolvedValueOnce({
          success: true,
          message: 'Login successful',
          userData: { displayName: 'Browser User' },
        });

      const result = await loginTool({ force: false });

      expect(authManager.acquireTokenInteractive).toHaveBeenCalled();
      expect(authManager.acquireTokenByDeviceCode).not.toHaveBeenCalled();
      expect(JSON.parse(result.content[0].text)).toEqual({
        status: 'Login successful',
        success: true,
        message: 'Login successful',
        userData: { displayName: 'Browser User' },
      });
      expect(result.isError).toBeUndefined();
    });

    it('should report failure, not success, when browser login cannot be verified', async () => {
      authManager.getUseInteractiveAuth.mockReturnValue(true);
      authManager.testLogin
        .mockResolvedValueOnce({ success: false, message: 'Not logged in' })
        .mockResolvedValueOnce({ success: false, message: 'Login failed - no token received' });

      const result = await loginTool({ force: false });

      expect(authManager.acquireTokenInteractive).toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toContain('Login successful');
      expect(JSON.parse(result.content[0].text)).toEqual({
        status: 'Login failed',
        success: false,
        message: 'Login failed - no token received',
        hint: LOGIN_FAILED_HINT,
      });
    });

    it('should proceed with login when not already logged in', async () => {
      authManager.testLogin.mockResolvedValue({
        success: false,
        message: 'Not logged in',
      });

      authManager.acquireTokenByDeviceCode.mockImplementation(
        (callback: (text: string) => void) => {
          callback('Login instructions');
          return Promise.resolve();
        }
      );

      const result = await loginTool({ force: false });

      expect(authManager.testLogin).toHaveBeenCalled();
      expect(authManager.acquireTokenByDeviceCode).toHaveBeenCalled();
      expect(result.content[0].text).toBe(
        JSON.stringify({
          error: 'device_code_required',
          message: 'Login instructions',
        })
      );
    });

    it('should proceed with login when expected account is missing', async () => {
      authManager.testLogin.mockResolvedValue({
        success: false,
        message: 'Expected Microsoft account not found in token cache.',
      });

      authManager.acquireTokenByDeviceCode.mockImplementation(
        (callback: (text: string) => void) => {
          callback('Login instructions');
          return Promise.resolve();
        }
      );

      const result = await loginTool({ force: false });

      expect(authManager.testLogin).toHaveBeenCalled();
      expect(authManager.acquireTokenByDeviceCode).toHaveBeenCalled();
      expect(result.content[0].text).toContain('device_code_required');
    });
  });

  describe('runCliLogin (--login)', () => {
    let log: ReturnType<typeof vi.spyOn>;
    let err: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      log = vi.spyOn(console, 'log').mockImplementation(() => {});
      err = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      log.mockRestore();
      err.mockRestore();
    });

    it('returns 0 and prints the result when the browser login verifies', async () => {
      const ok = { success: true, message: 'Login successful', userData: { displayName: 'U' } };
      authManager.testLogin.mockResolvedValue(ok);

      const code = await runCliLogin(authManager as never, true);

      expect(code).toBe(0);
      expect(authManager.acquireTokenInteractive).toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(JSON.stringify(ok));
      expect(err).not.toHaveBeenCalled();
    });

    it('returns non-zero with a fix hint when the browser login does not verify', async () => {
      authManager.testLogin.mockResolvedValue({
        success: false,
        message: 'Login successful but Graph API access failed: 401',
      });

      const code = await runCliLogin(authManager as never, true);

      expect(code).not.toBe(0);
      expect(err).toHaveBeenCalledWith(
        `Login failed: Login successful but Graph API access failed: 401\n${LOGIN_FAILED_HINT}`
      );
      expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
        success: false,
        message: 'Login successful but Graph API access failed: 401',
        hint: LOGIN_FAILED_HINT,
      });
    });

    it('returns non-zero when the device-code login does not verify', async () => {
      authManager.acquireTokenByDeviceCode.mockResolvedValue(undefined);
      authManager.testLogin.mockResolvedValue({
        success: false,
        message: 'Login failed - no token received',
      });

      const code = await runCliLogin(authManager as never, false);

      expect(code).toBe(1);
      expect(authManager.acquireTokenByDeviceCode).toHaveBeenCalled();
      expect(authManager.acquireTokenInteractive).not.toHaveBeenCalled();
    });
  });

  describe('verify-login tool', () => {
    it('should return JSON failure when verification throws', async () => {
      authManager.testLogin.mockRejectedValue(new Error('Expected Microsoft account missing'));

      const result = await verifyLoginTool({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed).toEqual({
        success: false,
        message: 'Login failed: Expected Microsoft account missing',
      });
      expect(result.isError).toBeUndefined();
    });
  });
});

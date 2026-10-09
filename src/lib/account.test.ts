import { describe, expect, it, beforeEach } from 'vitest';
import { isEmail, register, login, resetPassword, updatePassword, changePassword, authErrorMessage } from './account';

describe('account authentication logic', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('isEmail validator', () => {
    it('accepts valid UK and international email formats', () => {
      expect(isEmail('sarah@example.co.uk')).toBe(true);
      expect(isEmail('test.user+shop@gmail.com')).toBe(true);
      expect(isEmail('customer@huda-gymwear.com')).toBe(true);
    });

    it('rejects invalid email formats', () => {
      expect(isEmail('')).toBe(false);
      expect(isEmail('plainaddress')).toBe(false);
      expect(isEmail('@missingusername.com')).toBe(false);
      expect(isEmail('user@.com')).toBe(false);
      expect(isEmail('user@domain')).toBe(false);
      expect(isEmail('user @domain.com')).toBe(false);
    });
  });

  describe('provider error messages', () => {
    it('explains that an unverified Resend test sender blocks auth emails', () => {
      expect(authErrorMessage(new Error('Error sending confirmation email: validation_error')))
        .toMatch(/verify a sending domain in Resend/i);
    });

    it('does not expose unknown provider internals', () => {
      expect(authErrorMessage(new Error('opaque backend detail')))
        .toMatch(/try again in a moment/i);
    });
  });

  describe('register input validation', () => {
    it('rejects names shorter than 2 characters', async () => {
      const res = await register({ name: 'A', email: 'valid@example.co.uk', password: 'password123' });
      expect(res.error).toBe('Please enter your name.');
      expect(res.user).toBeUndefined();
    });

    it('rejects invalid email addresses', async () => {
      const res = await register({ name: 'Amelia', email: 'invalid-email', password: 'password123' });
      expect(res.error).toBe('Please enter a valid email address.');
      expect(res.user).toBeUndefined();
    });

    it('rejects passwords shorter than 6 characters', async () => {
      const res = await register({ name: 'Amelia', email: 'amelia@example.co.uk', password: '12345' });
      expect(res.error).toBe('Password must be at least 6 characters.');
      expect(res.user).toBeUndefined();
    });

    it('registers user successfully in demo/local fallback mode', async () => {
      const res = await register({ name: 'Amelia Clarke', email: 'amelia@example.co.uk', password: 'password123' });
      expect(res.error).toBeUndefined();
      expect(res.user).toBeDefined();
      expect(res.user?.email).toBe('amelia@example.co.uk');
      expect(res.user?.name).toBe('Amelia Clarke');
      expect(res.user?.role).toBe('customer');
    });

    it('prevents duplicate registration with the same email', async () => {
      await register({ name: 'Amelia Clarke', email: 'amelia@example.co.uk', password: 'password123' });
      const dup = await register({ name: 'Another Name', email: 'amelia@example.co.uk', password: 'anotherpass' });
      expect(dup.error).toMatch(/already exists/i);
    });
  });

  describe('login input validation', () => {
    it('rejects malformed email', async () => {
      const res = await login({ email: 'bademail', password: 'password123' });
      expect(res.error).toBe('Please enter a valid email address.');
    });

    it('rejects empty password', async () => {
      const res = await login({ email: 'amelia@example.co.uk', password: '' });
      expect(res.error).toBe('Please enter your password.');
    });

    it('rejects incorrect credentials', async () => {
      await register({ name: 'Amelia Clarke', email: 'amelia@example.co.uk', password: 'correctpass' });
      const res = await login({ email: 'amelia@example.co.uk', password: 'wrongpass' });
      expect(res.error).toBe('Incorrect email or password.');
    });

    it('authenticates with correct credentials', async () => {
      await register({ name: 'Amelia Clarke', email: 'amelia@example.co.uk', password: 'correctpass' });
      const res = await login({ email: 'amelia@example.co.uk', password: 'correctpass' });
      expect(res.error).toBeUndefined();
      expect(res.user?.email).toBe('amelia@example.co.uk');
    });
  });

  describe('password reset & change input validation', () => {
    it('rejects malformed email on password reset request', async () => {
      const res = await resetPassword('invalid-email');
      expect(res.error).toBe('Please enter a valid email address.');
    });

    it('rejects passwords shorter than 6 characters on update', async () => {
      const res = await updatePassword('123');
      expect(res.error).toBe('New password must be at least 6 characters.');
    });

    it('rejects passwords shorter than 6 characters on changePassword', async () => {
      const res = await changePassword('amelia@example.co.uk', 'oldpass', '123');
      expect(res.error).toBe('New password must be at least 6 characters.');
    });
  });
});
